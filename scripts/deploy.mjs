#!/usr/bin/env node
// Mocked deployment — SPEC.md §7.2.
//
// "Mocked" means there is no cloud behind it. Each environment is brought up on this machine, and the
// deployment is real and checkable: the app is started with that environment's variables, GET /healthz is
// polled until it answers 200, GET /api/version must name the environment that was asked for, and the
// result is written to <out-dir>/<env>.json (default .deploy/<env>.json).
//
// The image is the point. The CD workflow builds it once; every environment is handed the same `sha256:`
// digest. --image refuses anything that is not pinned by digest (a tag can move, a digest cannot), and the
// digest is recorded, so "dev, test and prod run the same thing" is enforced here and visible afterwards.
//
// Usage:
//   node scripts/deploy.mjs --env <dev|test|prod> --image <repository@sha256:digest> [--port <n>] [--mock] [--out-dir <dir>]
//   node scripts/deploy.mjs --self-test
//
//   (default)    run the image as a container and leave it running, so the smoke test can reach it
//   --mock       no container: compile the app and run it directly with node, then stop it again. This is a
//                local stand-in for the container; the CD workflows never use it.
//   --self-test  gate leg 7. Deploys one digest through dev, test and prod with --mock on throwaway ports,
//                smoke tests each, asserts the records, and leaves no process, port or file behind. It also checks
//                that the health deadline cancels a request that never finishes, and that cancelling a request
//                settles it at once even while it waits for the client's socket.
//
// Exit codes: 0 deployed; 1 the deployment failed (the reason is printed and recorded); 2 bad usage.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners, once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, runSmoke } from "./smoke.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT_DIR = join(ROOT, ".deploy");
export const ENVIRONMENTS = Object.freeze(["dev", "test", "prod"]);

// What differs between environments. APP_ENV is what /api/version reports. Production logs at info rather than
// warn on purpose: "server listening" is an info line, and a mock deployment learns that the app is up by reading it.
export const ENVIRONMENT_SETTINGS = Object.freeze({
    dev: Object.freeze({ LOG_LEVEL: "debug" }),
    test: Object.freeze({ LOG_LEVEL: "info" }),
    prod: Object.freeze({ LOG_LEVEL: "info" }),
});

// The keys of a deployment record. tools/report.py reads "environment"; "env" is the name the spec gives it.
export const RECORD_KEYS = Object.freeze(["env", "environment", "image", "digest", "timestamp", "outcome"]);

// Everything src/config.ts reads. A deployment starts from a clean slate, so none of it leaks in from the caller's shell.
const CONFIG_VARIABLES = Object.freeze(["PORT", "APP_ENV", "APP_VERSION", "GIT_COMMIT", "LOG_LEVEL", "ENABLE_INSECURE_DEMO"]);
const CONTAINER_PORT = 3000; // the port the Dockerfile EXPOSEs
const DEFAULT_HOST_PORT = 8080; // where a container is published when --port is not given

// Ceilings, not delays: nothing waits out time it does not need.
const COMPILE_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 500;
const STOP_TIMEOUT_MS = 10_000;
const DOCKER_TIMEOUT_MS = 600_000; // docker run pulls the image first
const OUTPUT_TAIL_LENGTH = 2_000;
const MAX_RECORD_AGE_MS = 5 * 60_000;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PINNED_REFERENCE = /^(?<repository>[a-z0-9][a-z0-9._:/-]*)@(?<digest>sha256:[0-9a-f]{64})$/;

export const USAGE = `Usage:
  node scripts/deploy.mjs --env <dev|test|prod> --image <repository@sha256:digest> [--port <n>] [--mock] [--out-dir <dir>]
  node scripts/deploy.mjs --self-test

  --env        the environment to deploy to
  --image      the image to deploy, pinned by digest: ghcr.io/owner/name@sha256:<64 hex digits>
  --port       the host port to serve on (container default ${DEFAULT_HOST_PORT}; with --mock the default is any free port)
  --mock       run the compiled app directly with node instead of a container, then stop it again
  --out-dir    where <env>.json is written (default .deploy)
  --self-test  deploy one digest through dev, test and prod with --mock on throwaway ports, then clean up
               (the other options are ignored)
`;

export class UsageError extends Error {
    name = "UsageError";
}

export class DeployError extends Error {
    name = "DeployError";
}

// --- pure helpers ------------------------------------------------------------

/**
 * Splits an --image value into its parts. A deployment has to name an immutable digest: that is what makes
 * "the same image in every environment" true.
 *
 * @param {string} value  `<repository>@sha256:<64 hex digits>`, or a bare `sha256:<64 hex digits>`
 * @returns {{ image: string, repository: string | undefined, digest: string }}
 */
export function parseImage(value) {
    if (DIGEST.test(value)) return { image: value, repository: undefined, digest: value };
    const match = PINNED_REFERENCE.exec(value);
    if (match === null) {
        throw new UsageError(
            `--image must be pinned by digest, as <repository>@sha256:<64 hex digits>, got ${JSON.stringify(value)}. ` +
                "Build once and promote that digest: a tag can move, a digest cannot.",
        );
    }
    return { image: value, repository: match.groups.repository, digest: match.groups.digest };
}

/**
 * The variables an environment's app is started with: the label it reports, the port it listens on, and the
 * environment's own settings. The deliberately vulnerable demo routes (SPEC.md §5.2) are off in every
 * environment, stated here rather than left to the app's default.
 *
 * @param {string} env
 * @param {number} port
 */
export function appVariables(env, port) {
    return { APP_ENV: env, PORT: String(port), ENABLE_INSECURE_DEMO: "false", ...ENVIRONMENT_SETTINGS[env] };
}

/** The name an environment's container is given, so a redeploy replaces the one before it. */
export const containerName = (env) => `widget-showcase-${env}`;

/**
 * The arguments for `docker run`. The container is published on the loopback interface only, runs with no
 * extra privileges, and is addressed by the digest it was given: docker verifies a pulled image against it.
 */
export function dockerRunArgs({ name, image, hostPort, variables }) {
    return [
        "run",
        "--detach",
        "--name",
        name,
        "--publish",
        `127.0.0.1:${hostPort}:${CONTAINER_PORT}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        ...Object.entries(variables).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        image,
    ];
}

/**
 * The deployment record. "env" and "environment" carry the same value: the spec calls the field env, and
 * tools/report.py reads environment. A failed deployment also says why.
 */
export function buildRecord({ env, image, digest, outcome, reason, now = new Date() }) {
    const record = { env, environment: env, image, digest, timestamp: now.toISOString(), outcome };
    if (reason !== undefined) record.reason = reason;
    return record;
}

/** The port in the app's `server listening` log line, or undefined if the line is anything else. */
export function listeningPort(line) {
    let event;
    try {
        event = JSON.parse(line);
    } catch {
        return undefined;
    }
    return event?.msg === "server listening" && Number.isInteger(event.port) ? event.port : undefined;
}

function parsePort(raw) {
    if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new UsageError(`--port must be an integer from 0 to 65535, got ${JSON.stringify(raw)}`);
    return Number(raw);
}

/**
 * @param {string[]} argv
 * @returns {{
 *   help: boolean, selfTest: boolean, mock: boolean, env?: string, image?: string, digest?: string,
 *   repository?: string, port?: number, outDir: string,
 * }}
 */
export function parseArgs(argv) {
    const options = {
        help: false,
        selfTest: false,
        mock: false,
        env: undefined,
        image: undefined,
        digest: undefined,
        repository: undefined,
        port: undefined,
        outDir: DEFAULT_OUT_DIR,
    };
    let index = 0;
    while (index < argv.length) {
        const arg = argv[index++];
        const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
        const flag = equals === -1 ? arg : arg.slice(0, equals);
        const inline = equals === -1 ? undefined : arg.slice(equals + 1);
        const value = () => {
            const given = inline ?? argv[index++];
            if (given === undefined) throw new UsageError(`${flag} needs a value`);
            return given;
        };
        const toggle = () => {
            if (inline !== undefined) throw new UsageError(`${flag} does not take a value`);
            return true;
        };
        switch (flag) {
            case "--env":
                options.env = value();
                break;
            case "--image":
                options.image = value();
                break;
            case "--port":
                options.port = parsePort(value());
                break;
            case "--out-dir":
                options.outDir = resolve(value());
                break;
            case "--mock":
                options.mock = toggle();
                break;
            case "--self-test":
                options.selfTest = toggle();
                break;
            case "--help":
            case "-h":
                options.help = toggle();
                break;
            default:
                throw new UsageError(`unknown option ${JSON.stringify(arg)}`);
        }
    }
    if (options.help || options.selfTest) return options;

    if (options.env === undefined) throw new UsageError("--env is required");
    if (!ENVIRONMENTS.includes(options.env)) {
        throw new UsageError(`--env must be one of ${ENVIRONMENTS.join(", ")}, got ${JSON.stringify(options.env)}`);
    }
    if (options.image === undefined) throw new UsageError("--image is required");
    const { repository, digest } = parseImage(options.image);
    options.repository = repository;
    options.digest = digest;
    if (!options.mock && repository === undefined) {
        throw new UsageError("a container cannot be run from a bare digest: pass <repository>@sha256:<digest> (a bare digest is accepted only with --mock)");
    }
    if (!options.mock && options.port === 0) {
        throw new UsageError("--port 0 (any free port) is only available with --mock: a container is published on a fixed host port");
    }
    return options;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const errorText = (error) => (error instanceof Error ? error.message : String(error));
const withOutput = (message, output) => (output ? `${message}\napp output:\n${output}` : message);
const shortDigest = (digest) => `${digest.slice(0, 19)}…`;

function withTimeout(promise, ms, message) {
    let timer;
    const expired = new Promise((_, fail) => {
        timer = setTimeout(() => fail(new DeployError(message)), ms);
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// --- what has been started ---------------------------------------------------

// Every app this process started and has not yet stopped, and every throwaway directory it made and has not yet
// removed. The exit and signal handlers installed by the command line use them, so an interrupted deployment does
// not leave a process, a container or a directory behind.
const live = new Set();
const pendingCleanups = new Set();

/** Registers a synchronous cleanup. The function returned runs it once; calling it again does nothing. */
function onceCleanup(cleanup) {
    const run = () => {
        if (pendingCleanups.delete(run)) cleanup();
    };
    pendingCleanups.add(run);
    return run;
}

async function stopChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    const force = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    try {
        child.kill();
        await closed;
    } finally {
        clearTimeout(force);
    }
}

// --- the compiled app --------------------------------------------------------

/**
 * Compiles src/ into a throwaway directory with the same command the Dockerfile's build stage uses, so `--mock`
 * runs what the container would run. The directory sits under .deploy/ (git-ignored) so that node finds the
 * repository's node_modules by walking up from it, and it holds a copy of public/ because the app reads
 * ../public/index.html relative to its own compiled file.
 *
 * @param {string} [root]
 * @returns {{ dir: string, entry: string, cleanup: () => void }}
 */
export function compileApp(root = ROOT) {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(tsc)) {
        throw new DeployError(`--mock compiles the app with the TypeScript compiler, and ${tsc} does not exist; run npm ci first`);
    }
    const parent = join(root, ".deploy");
    const parentExisted = existsSync(parent);
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, "mock-build-"));
    const cleanup = onceCleanup(() => {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (!parentExisted) {
            try {
                rmdirSync(parent);
            } catch {
                // Something else lives there now (a deployment record, say): leave it.
            }
        }
    });

    try {
        for (const name of ["src", "public", "tsconfig.json", "package.json"]) {
            cpSync(join(root, name), join(dir, name), { recursive: true });
        }
        const compiled = spawnSync(process.execPath, [tsc, "--noEmit", "false", "--outDir", "dist", "--rootDir", "src"], {
            cwd: dir,
            encoding: "utf8",
            timeout: COMPILE_TIMEOUT_MS,
            windowsHide: true,
        });
        if (compiled.error !== undefined || compiled.status !== 0) {
            const detail = compiled.error === undefined ? `${compiled.stdout}${compiled.stderr}`.trim() : compiled.error.message;
            throw new DeployError(`compiling the app failed: ${detail}`);
        }
        const entry = join(dir, "dist", "server.js");
        if (!existsSync(entry)) throw new DeployError(`compiling the app did not produce ${entry}`);
        return { dir, entry, cleanup };
    } catch (error) {
        cleanup();
        throw error;
    }
}

// --- starting an environment -------------------------------------------------

// Reads the child's output. The only way this learns that the app is up is the line the app itself logs when
// it is listening, so no connection is made to a port that is not open yet.
function watchOutput(child) {
    let tail = "";
    let pending = "";
    const remember = (chunk) => {
        tail = (tail + chunk).slice(-OUTPUT_TAIL_LENGTH);
    };
    const listening = new Promise((announce, fail) => {
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            remember(chunk);
            const lines = (pending + chunk).split("\n");
            pending = lines.pop();
            for (const line of lines) {
                const port = listeningPort(line);
                if (port !== undefined) announce(port);
            }
        });
        child.stderr.on("data", remember);
        child.once("error", (error) => fail(new DeployError(`could not start the app: ${error.message}`)));
        child.once("close", (code, signal) => fail(new DeployError(`the app exited (${signal ?? `code ${code}`}) before it was listening`)));
    });
    // Nobody may be awaiting this by the time the child closes, and an unhandled rejection would crash the process.
    listening.catch(() => undefined);
    return { listening, output: () => tail.trim() };
}

async function startMockApp({ build, appEnv, port }) {
    const environment = { ...process.env };
    for (const name of CONFIG_VARIABLES) delete environment[name];
    Object.assign(environment, appVariables(appEnv, port));

    const child = spawn(process.execPath, [build.entry], {
        cwd: build.dir,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const { listening, output } = watchOutput(child);
    const app = {
        pid: child.pid,
        port: undefined,
        baseUrl: undefined,
        isAlive: () => child.exitCode === null && child.signalCode === null,
        diagnostics: output,
        async stop() {
            live.delete(app);
            await stopChild(child);
        },
        stopSync() {
            try {
                child.kill("SIGKILL");
            } catch {
                // It is already gone.
            }
        },
        detach() {
            live.delete(app);
        },
    };
    live.add(app);

    try {
        const actual = await withTimeout(listening, STARTUP_TIMEOUT_MS, `the app did not log "server listening" within ${STARTUP_TIMEOUT_MS / 1000}s`);
        if (port !== 0 && actual !== port) throw new DeployError(`the app is listening on port ${actual}, not on the requested port ${port}`);
        app.port = actual;
        app.baseUrl = `http://127.0.0.1:${actual}`;
        return app;
    } catch (error) {
        const reason = withOutput(errorText(error), output());
        await app.stop();
        throw new DeployError(reason);
    }
}

function docker(args, { allowFailure = false, timeoutMs = 60_000 } = {}) {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    if (result.error !== undefined) {
        if (allowFailure) return { ok: false, stdout: "", stderr: result.error.message };
        throw new DeployError(
            result.error.code === "ENOENT"
                ? "docker is not installed or not on PATH (pass --mock to run the app directly with node)"
                : `could not run docker: ${result.error.message}`,
        );
    }
    if (result.status !== 0 && !allowFailure) {
        throw new DeployError(`docker ${args[0]} failed (${result.signal ?? `exit ${result.status}`}): ${(result.stderr || result.stdout).trim()}`);
    }
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

async function startContainer({ env, image, port }) {
    const name = containerName(env);
    const hostPort = port ?? DEFAULT_HOST_PORT;
    const remove = () => docker(["rm", "--force", name], { allowFailure: true });
    const app = {
        pid: undefined,
        port: hostPort,
        baseUrl: `http://127.0.0.1:${hostPort}`,
        isAlive: () => docker(["inspect", "--format", "{{.State.Running}}", name], { allowFailure: true }).stdout.trim() === "true",
        diagnostics() {
            const logs = docker(["logs", "--tail", "40", name], { allowFailure: true });
            return `${logs.stdout}${logs.stderr}`.trim();
        },
        async stop() {
            live.delete(app);
            remove();
        },
        stopSync: remove,
        detach() {
            live.delete(app);
        },
    };

    // An environment has one deployment: the one this replaces goes first.
    remove();
    live.add(app);
    try {
        docker(dockerRunArgs({ name, image, hostPort, variables: appVariables(env, CONTAINER_PORT) }), { timeoutMs: DOCKER_TIMEOUT_MS });
        return app;
    } catch (error) {
        await app.stop();
        throw error;
    }
}

// --- verifying an environment ------------------------------------------------

const NO_TIME_LEFT = Symbol("no time left");

// One GET /healthz, given at most `budgetMs`. It does not throw: it says whether the app answered 200 and, if it did
// not, what was seen instead. If the budget runs out first, the request is cancelled. Two mechanisms, for two kinds of
// failure: the AbortSignal tears down a real connection, and racing the request against a timer bounds a client that
// never settles or ignores the signal.
async function checkHealth(client, budgetMs) {
    const cancel = new AbortController();
    let timer;
    const outOfTime = new Promise((done) => {
        timer = setTimeout(done, budgetMs, NO_TIME_LEFT);
    });
    try {
        const response = await Promise.race([client.request("GET", "/healthz", undefined, { signal: cancel.signal }), outOfTime]);
        if (response === NO_TIME_LEFT) {
            cancel.abort();
            return { healthy: false, expired: true, last: "no response had finished when the time ran out" };
        }
        return response.status === 200 ? { healthy: true } : { healthy: false, last: `HTTP ${response.status}` };
    } catch (error) {
        return { healthy: false, last: errorText(error) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Polls GET /healthz until it answers 200, or fails once the app has stopped or the timeout has passed.
 *
 * The timeout is a deadline on the whole wait, requests included. A request still in flight when it arrives is
 * cancelled, so an app that answers slowly, or sends a response that never ends, cannot hold a deployment past it.
 * The client's own timeout cannot do this job: smoke.mjs's is an idle timeout, and every byte that trickles in resets it.
 *
 * @param {{ request: (method: string, path: string, body?: unknown, options?: { signal?: AbortSignal }) => Promise<{ status: number }> }} client
 * @param {{ isAlive?: () => boolean, timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitForHealthy(client, { isAlive = () => true, timeoutMs = HEALTH_TIMEOUT_MS, intervalMs = HEALTH_INTERVAL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    const timedOut = (last) => new DeployError(`GET /healthz did not return 200 within ${timeoutMs / 1000}s (last result: ${last})`);
    let last = "no answer yet";
    for (;;) {
        if (!isAlive()) throw new DeployError("the app stopped before GET /healthz returned 200");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timedOut(last);
        const attempt = await checkHealth(client, remaining);
        if (attempt.healthy) return;
        last = attempt.last;
        if (attempt.expired || Date.now() + intervalMs >= deadline) throw timedOut(last);
        await sleep(intervalMs);
    }
}

async function expectEnvironment(client, env) {
    const response = await client.request("GET", "/api/version");
    if (response.status !== 200) throw new DeployError(`GET /api/version returned HTTP ${response.status}, expected 200`);
    let body;
    try {
        body = JSON.parse(response.text);
    } catch {
        throw new DeployError("GET /api/version did not return JSON");
    }
    if (body?.environment !== env) {
        throw new DeployError(`GET /api/version reports environment ${JSON.stringify(body?.environment)}, expected ${JSON.stringify(env)}`);
    }
}

/** Writes <outDir>/<env>.json and returns its path. */
export function writeRecord(outDir, record) {
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${record.env}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    return file;
}

/**
 * Deploys one environment: starts it, waits until it is healthy, checks that it reports the environment that was
 * asked for, and writes the deployment record. It resolves with the running deployment, which the caller stops
 * (stop) or leaves running (detach). If anything fails it stops what it started, records the failure and throws.
 *
 * @param {object} options
 * @param {string} options.env       dev, test or prod
 * @param {string} options.image     the image reference, recorded as given
 * @param {string} options.digest    the `sha256:` digest of the image, recorded as given
 * @param {boolean} [options.mock]   run the compiled app directly instead of a container
 * @param {number} [options.port]    host port; with mock, 0 or absent means any free port
 * @param {string} [options.outDir]  where the record goes
 * @param {{ entry: string, dir: string }} [options.build]  a compiled app to reuse; without one, mock compiles its own
 * @param {string} [options.appEnv]  start the app labelled with this instead of env. For the self-test, which uses
 *                                   it to prove that an app reporting the wrong environment is refused.
 */
export async function deployEnvironment({ env, image, digest, mock = false, port, outDir = DEFAULT_OUT_DIR, build, appEnv = env }) {
    if (!ENVIRONMENTS.includes(env)) throw new UsageError(`env must be one of ${ENVIRONMENTS.join(", ")}, got ${JSON.stringify(env)}`);

    let ownBuild;
    let app;
    let client;
    // The app is stopped before the build it runs from is removed: on Windows a running process holds its working
    // directory open, so that directory cannot be deleted from under it.
    const teardown = async () => {
        try {
            client?.close();
            await app?.stop();
        } finally {
            ownBuild?.cleanup();
        }
    };

    try {
        if (mock) {
            ownBuild = build === undefined ? compileApp() : undefined;
            app = await startMockApp({ build: build ?? ownBuild, appEnv, port: port ?? 0 });
        } else {
            app = await startContainer({ env, image, port });
        }
        client = createClient(app.baseUrl);
        await waitForHealthy(client, { isAlive: app.isAlive });
        await expectEnvironment(client, env);
        const record = buildRecord({ env, image, digest, outcome: "success" });
        const file = writeRecord(outDir, record);
        return {
            record,
            file,
            client,
            baseUrl: app.baseUrl,
            port: app.port,
            pid: app.pid,
            stop: teardown,
            // For a container, which is meant to outlive this process. A mock app has no such use: it is stopped.
            detach() {
                client.close();
                app.detach();
            },
        };
    } catch (cause) {
        // Read the app's output before stopping it: a container's logs go with the container.
        let reason = withOutput(errorText(cause), app?.diagnostics());
        try {
            await teardown();
        } catch (stopError) {
            reason += `\nstopping the app also failed: ${errorText(stopError)}`;
        }
        try {
            writeRecord(outDir, buildRecord({ env, image, digest, outcome: "failure", reason }));
        } catch {
            // The deployment failed already. Failing to say so on disk must not hide why.
        }
        throw new DeployError(reason, { cause });
    }
}

// --- the self-test (gate leg 7) ----------------------------------------------

function check(condition, message) {
    if (!condition) throw new DeployError(`self-test: ${message}`);
}

const refuses = (action) => {
    try {
        action();
    } catch (error) {
        return error instanceof UsageError;
    }
    return false;
};

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

// A bind succeeds only if nothing is listening on the port. This never connects to it. It binds the wildcard
// address, as the app does.
async function isPortFree(port, { attempts = 20, intervalMs = 100 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const free = await new Promise((settle) => {
            const probe = createServer();
            probe.once("error", () => settle(false));
            probe.listen(port, () => probe.close(() => settle(true)));
        });
        if (free) return true;
        await sleep(intervalMs);
    }
    return false;
}

function assertRecord(file, expected) {
    check(existsSync(file), `${file} was not written`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    for (const key of RECORD_KEYS) check(Object.hasOwn(record, key), `the ${expected.env} record has no "${key}"`);
    check(record.env === expected.env && record.environment === expected.env, `the ${expected.env} record names environment ${JSON.stringify(record.environment)}`);
    check(record.image === expected.image, `the ${expected.env} record names image ${JSON.stringify(record.image)}, not ${JSON.stringify(expected.image)}`);
    check(record.digest === expected.digest, `the ${expected.env} record carries digest ${JSON.stringify(record.digest)}, not ${JSON.stringify(expected.digest)}`);
    check(record.outcome === expected.outcome, `the ${expected.env} record says outcome ${JSON.stringify(record.outcome)}, expected ${JSON.stringify(expected.outcome)}`);
    check(Math.abs(Date.now() - Date.parse(record.timestamp)) < MAX_RECORD_AGE_MS, `the ${expected.env} record has no recent timestamp (${JSON.stringify(record.timestamp)})`);
    return record;
}

// A server whose /healthz answers 503 and then never finishes the response: it sends a byte every few milliseconds for as
// long as the client stays. smoke.mjs's client times out on idleness and these bytes keep resetting that, so nothing but a
// deadline on the whole health wait can end the request. `wasCancelled` settles when the client hangs up.
async function startTricklingServer() {
    let hangUp;
    let requests = 0;
    const wasCancelled = new Promise((done) => {
        hangUp = done;
    });
    const server = createHttpServer((_request, response) => {
        requests += 1;
        response.writeHead(503, { "content-type": "text/plain" });
        const drip = setInterval(() => response.write("."), 10);
        response.once("close", () => {
            clearInterval(drip);
            hangUp();
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        port: server.address().port,
        requestsSeen: () => requests,
        wasCancelled,
        async stop() {
            server.closeAllConnections();
            await new Promise((done) => server.close(done));
        },
    };
}

// A server whose first response is held open: it sends the headers and a byte, then another every few milliseconds, until
// release() ends it. While that response is in flight the client's one socket is busy, and the bytes keep it from ever going
// idle. Every other request is answered at once. `paths` is what the server was asked for, in order.
async function startHoldingServer() {
    const paths = [];
    let announce;
    let release;
    const holding = new Promise((done) => {
        announce = done;
    });
    const released = new Promise((done) => {
        release = done;
    });
    const server = createHttpServer((request, response) => {
        paths.push(request.url);
        response.writeHead(200, { "content-type": "text/plain" });
        if (paths.length > 1) {
            response.end("answered");
            return;
        }
        response.write(".");
        const drip = setInterval(() => response.write("."), 10);
        response.once("close", () => clearInterval(drip));
        released.then(() => response.end("released"));
        announce();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        port: server.address().port,
        paths,
        holding,
        release,
        async stop() {
            server.closeAllConnections();
            await new Promise((done) => server.close(done));
        },
    };
}

/**
 * The health timeout is a deadline on the whole wait, so a request that never finishes must not outlast it. Two cases:
 * a real HTTP response that keeps arriving, which the deadline has to cancel and not merely walk away from, and a
 * client that never answers at all. If the deadline did not reach a request in flight, either would leave the wait
 * pending for good; the watchdog is far longer than the deadline and only turns that hang into a failure.
 *
 * @returns {Promise<string>} what was shown, for the log
 */
async function checkHealthDeadline({ timeoutMs = 150, watchdogMs = 5_000 } = {}) {
    const outcome = (wait) => wait.then(() => "healthy", (error) => error);
    const describe = (result) => (result instanceof Error ? result.message : String(result));
    const endedByDeadline = (result) => result instanceof DeployError && result.message.includes("did not return 200 within");
    const hung = (what) => `self-test: a ${timeoutMs} ms health deadline did not end ${what} within ${watchdogMs} ms`;

    const server = await startTricklingServer();
    const client = createClient(`http://127.0.0.1:${server.port}`);
    const started = Date.now();
    let elapsedMs;
    let reached;
    try {
        const result = await withTimeout(outcome(waitForHealthy(client, { timeoutMs, intervalMs: 10 })), watchdogMs, hung("a response that never finishes"));
        elapsedMs = Date.now() - started;
        reached = server.requestsSeen() > 0;
        check(endedByDeadline(result), `a response that never finishes must end the health wait with its deadline, got: ${describe(result)}`);
        // Walking away is not cancelling: the server must see the connection close. This is checked before the server is
        // stopped, because stopping it closes the connection as well. A request that had not even reached the server by the
        // deadline has nothing to close, so it is not held to this.
        if (reached) {
            await withTimeout(server.wasCancelled, watchdogMs, "self-test: the request in flight at the health deadline was abandoned, not cancelled: its connection stayed open");
        }
    } finally {
        client.close();
        await server.stop();
    }
    check(await isPortFree(server.port), `port ${server.port} is still bound after the trickling server was stopped`);

    const silent = await withTimeout(
        outcome(waitForHealthy({ request: () => new Promise(() => undefined) }, { timeoutMs, intervalMs: 10 })),
        watchdogMs,
        hung("a client that never answers"),
    );
    check(endedByDeadline(silent), `a client that never answers must end the health wait with its deadline, got: ${describe(silent)}`);

    return `a ${timeoutMs} ms health deadline ended a response that never finishes after ${elapsedMs} ms${reached ? " and cancelled it" : ""}, and ended a client that never answers`;
}

/**
 * Cancelling a request settles it at once, however far it had got. The case that is easy to get wrong is a request that
 * has not been sent. The client has one socket, so a request made while a response is still arriving waits for that
 * socket, and the request says nothing, not even that it was cancelled, until the socket is free: which a response that
 * never ends puts off for good. So the cancelled request must reject while that response is still streaming, must never
 * reach the server, and must take nothing from the response ahead of it or from the requests made after it. Also checked:
 * a signal that was aborted before the request was made sends nothing, and a finished request lets go of its signal. The
 * watchdog is far longer than any of this needs and only turns a hang into a failure.
 *
 * @returns {Promise<string>} what was shown, for the log
 */
async function checkQueuedCancellation({ watchdogMs = 5_000 } = {}) {
    // A call's outcome, as a value: nothing here may leave a rejection unhandled.
    const outcome = (call) => call.then((response) => ({ response }), (error) => ({ error }));
    const describe = ({ response, error }) => (error === undefined ? `HTTP ${response.status}` : `${error?.code ?? error?.name ?? "error"}: ${errorText(error)}`);
    const isAbort = (error) => error instanceof Error && error.name === "AbortError" && error.code === "ABORT_ERR";

    const server = await startHoldingServer();
    const client = createClient(`http://127.0.0.1:${server.port}`);
    let elapsedMs;
    try {
        // A signal that is already aborted: the request is not made at all.
        const early = new AbortController();
        early.abort();
        const unsent = await withTimeout(
            outcome(client.request("GET", "/never-sent", undefined, { signal: early.signal })),
            watchdogMs,
            `self-test: a request made with an aborted signal was still pending ${watchdogMs} ms later`,
        );
        check(isAbort(unsent.error), `a request made with an aborted signal must reject with an AbortError, got: ${describe(unsent)}`);

        // A response that does not end holds the client's one socket ...
        const ahead = outcome(client.request("GET", "/ahead"));
        await withTimeout(server.holding, watchdogMs, "self-test: the response that was to hold the client's socket never started");

        // ... so a request made now waits behind it. Cancelling that request must not.
        const cancel = new AbortController();
        const queued = outcome(client.request("GET", "/queued", undefined, { signal: cancel.signal }));
        const cancelledAt = Date.now();
        cancel.abort();
        const cancelled = await withTimeout(
            queued,
            watchdogMs,
            `self-test: a request cancelled while it waited for the client's socket was still pending ${watchdogMs} ms later, held up by a response that is still streaming`,
        );
        elapsedMs = Date.now() - cancelledAt;
        check(isAbort(cancelled.error), `a request cancelled while it waited for the client's socket must reject with an AbortError, got: ${describe(cancelled)}`);

        // The response ahead of it is untouched: it carries on and completes once the server ends it ...
        server.release();
        const first = await withTimeout(ahead, watchdogMs, "self-test: the response ahead of a cancelled request did not complete once it was released");
        check(first.response?.status === 200 && first.response.text.endsWith("released"), `the response ahead of a cancelled request must complete, got: ${describe(first)}`);

        // ... and the client carries on with the next request, which has its own signal and lets go of it when it is done.
        const later = new AbortController();
        const next = await withTimeout(
            outcome(client.request("GET", "/after", undefined, { signal: later.signal })),
            watchdogMs,
            "self-test: a request made after a cancelled one did not complete",
        );
        check(next.response?.status === 200, `a request made after a cancelled one must be answered, got: ${describe(next)}`);
        check(getEventListeners(later.signal, "abort").length === 0, "a request that has finished must stop listening to its signal");

        // The cancelled request was queued ahead of that one, so it has been passed over by now: it must not have been sent.
        check(server.paths.join(" ") === "/ahead /after", `a cancelled request must never reach the server, but the server was asked for: ${server.paths.join(", ")}`);
    } finally {
        client.close();
        await server.stop();
    }
    check(await isPortFree(server.port), `port ${server.port} is still bound after the holding server was stopped`);

    return `a request cancelled while it waited behind a response that never ends was rejected after ${elapsedMs} ms and never sent; the response ahead of it and the next request were unaffected`;
}

/**
 * Deploys one digest through dev, test and prod with --mock on throwaway ports. Each deployment must come up
 * healthy, report its own environment, write its record and pass the smoke test, and each must stop without
 * leaving a process or a bound port. A deployment that reports the wrong environment must be refused. The health
 * deadline must end a request that never finishes, and cancelling a request must settle it at once even when it is
 * still waiting for the client's socket. Throws a DeployError describing the first thing that does not hold.
 */
export async function selfTest({ log = console.log, root = ROOT } = {}) {
    const say = (line) => log(`deploy self-test: ${line}`);
    const scratch = mkdtempSync(join(tmpdir(), "deploy-self-test-"));
    const outDir = join(scratch, "records");
    const removeScratch = onceCleanup(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    let build;

    try {
        // Without a digest there is nothing to promote, so the image and the arguments that would deploy it are refused.
        check(refuses(() => parseImage("ghcr.io/example/widget-showcase:latest")), "an image named by tag instead of digest must be refused");
        check(
            refuses(() => parseArgs(["--env", "dev", "--image", `sha256:${"0".repeat(64)}`])),
            "a container cannot be run from a bare digest, so that must be refused without --mock",
        );

        const digest = `sha256:${createHash("sha256").update("deploy.mjs --self-test").digest("hex")}`;
        const image = `ghcr.io/example/widget-showcase@${digest}`;

        // The container path needs a docker daemon, which this test cannot assume. What it can check is the command
        // that path issues: it runs the image it was given, by digest, and it never builds one.
        const runArgs = dockerRunArgs({ name: containerName("prod"), image, hostPort: 8080, variables: appVariables("prod", CONTAINER_PORT) });
        check(runArgs[0] === "run" && !runArgs.includes("build"), "the container command must run an image and never build one");
        check(runArgs.at(-1) === image, "the container must be started from the image reference it was given, by digest");
        check(runArgs.includes("127.0.0.1:8080:3000") && runArgs.includes("APP_ENV=prod"), "the container must be published on loopback and given its environment's variables");

        // The health timeout bounds the whole wait, requests included, and cancelling a request settles it at once. Both are
        // checked here, before the slow part, so a regression fails fast and does not have to wait for the app to compile.
        say(await checkHealthDeadline());
        say(await checkQueuedCancellation());

        say("compiling the app once; every environment below runs that same build");
        build = compileApp(root);

        const records = [];
        for (const env of ENVIRONMENTS) {
            const deployment = await deployEnvironment({ env, image, digest, mock: true, port: 0, outDir, build });
            let smoke;
            try {
                records.push(assertRecord(deployment.file, { env, image, digest, outcome: "success" }));
                const lines = [];
                smoke = await runSmoke(deployment.client, { log: (line) => lines.push(line) });
                check(smoke.ok, `the smoke test failed against ${env}:\n${lines.join("\n")}`);
            } finally {
                await deployment.stop();
            }
            check(!isProcessAlive(deployment.pid), `the ${env} app (pid ${deployment.pid}) is still running after it was stopped`);
            check(await isPortFree(deployment.port), `port ${deployment.port} is still bound after the ${env} app was stopped`);
            say(`${env.padEnd(4)} ${shortDigest(digest)} on port ${deployment.port}: healthy, reports "${env}", record written, smoke ${smoke.passed}/${smoke.total}, stopped`);
        }

        // The point of the pipeline: one build, and every environment holds the same digest.
        check(new Set(records.map((record) => record.digest)).size === 1, "dev, test and prod must all carry one and the same digest");

        // The environment check has to be able to fail, or passing it proves nothing.
        let refused;
        try {
            await (await deployEnvironment({ env: "dev", image, digest, mock: true, port: 0, outDir, build, appEnv: "prod" })).stop();
        } catch (error) {
            refused = error;
        }
        check(refused instanceof DeployError && refused.message.includes("reports environment"), "an app that reports the wrong environment must be refused");
        const failure = JSON.parse(readFileSync(join(outDir, "dev.json"), "utf8"));
        check(failure.outcome === "failure" && typeof failure.reason === "string", "a refused deployment must be recorded as a failure, with its reason");
        say("an app reporting the wrong environment was refused and recorded as a failure");

        check(live.size === 0, `${live.size} app(s) are still running`);
        build.cleanup();
        removeScratch();
        check(!existsSync(build.dir) && !existsSync(scratch), "temporary files were left behind");
        say(`PASS — one digest promoted through ${ENVIRONMENTS.join(", ")}; no process, port or file left behind`);
    } finally {
        build?.cleanup();
        removeScratch();
    }
}

// --- command line ------------------------------------------------------------

async function deployOnce(options, log) {
    const { env, image, digest, mock, port, outDir } = options;
    const deployment = await deployEnvironment({ env, image, digest, mock, port, outDir });
    const summary = `${env}: ${shortDigest(digest)} answered GET /healthz and reports environment "${env}" at ${deployment.baseUrl}`;
    if (mock) {
        await deployment.stop();
        log(`deploy: ${summary}; the mock app has been stopped`);
    } else {
        deployment.detach();
        log(`deploy: ${summary}; left running as ${containerName(env)} (stop it with: docker rm --force ${containerName(env)})`);
    }
    log(`deploy: record written to ${deployment.file}`);
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (cause) {
        if (!(cause instanceof UsageError)) throw cause;
        error(`deploy: ${cause.message}`);
        error(USAGE);
        return 2;
    }
    if (options.help) {
        log(USAGE);
        return 0;
    }

    try {
        if (options.selfTest) await selfTest({ log });
        else await deployOnce(options, log);
        return 0;
    } catch (cause) {
        error(cause instanceof DeployError ? `deploy: FAILED — ${cause.message}` : `deploy: unexpected error — ${cause?.stack ?? cause}`);
        return 1;
    }
}

// Only the command line installs these: a module that imports this file should not get process-wide handlers.
function installProcessGuards() {
    process.on("exit", () => {
        for (const app of live) app.stopSync();
        for (const run of [...pendingCleanups]) run();
    });
    for (const [signal, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
    ]) {
        process.once(signal, () => {
            console.error(`deploy: ${signal} received; stopping what was started`);
            Promise.allSettled([...live].map((app) => app.stop())).finally(() => process.exit(code));
        });
    }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    installProcessGuards();
    const code = await main();
    process.exitCode = code;
    // Everything this script started has been stopped, so the event loop drains and the process ends by itself.
    // The timer is a backstop against a handle that was missed, and it does not keep the process alive.
    setTimeout(() => process.exit(code), 5_000).unref();
}
