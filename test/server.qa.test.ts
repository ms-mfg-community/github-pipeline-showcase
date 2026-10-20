import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { Agent, get, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_VARIABLES = ["PORT", "APP_ENV", "APP_VERSION", "GIT_COMMIT", "LOG_LEVEL", "ENABLE_INSECURE_DEMO"];
// Compiling the server and booting it in a child process both slow down when every other test file is competing
// for the same CPUs. These are ceilings, not delays: nothing here waits out time it does not need.
const COMPILE_TIMEOUT_MS = 90_000;
const STARTUP_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;
// "server listening" is an info-level line, so a child run at warn or error says nothing when it starts. Waiting for
// the line would never end, and the only other way to learn that such a child is up is to connect to its port until
// something answers, which spends connections on a port that is not open yet. So a child at one of those levels is
// started with this preload as well: it prints that same line from the server's own 'listening' event. It adds the
// line and nothing else. The process is still the compiled server on the PORT it was given, and every request below
// still goes to that port.
const ANNOUNCE_LISTENING = `data:text/javascript,${encodeURIComponent(`
import { Server } from "node:net";
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
    this.once("listening", () => process.stdout.write(JSON.stringify({ msg: "server listening", port: this.address()?.port }) + "\\n"));
    return listen.apply(this, args);
};
`)}`;
let scratch: string;
const children: ChildProcess[] = [];
const agents: Agent[] = [];

beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "showcase-wp1-qa-server-"));
    for (const path of ["src", "public", "tsconfig.json", "package.json"]) {
        cpSync(join(ROOT, path), join(scratch, path), { recursive: true });
    }
    symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    // Same emit command as Dockerfile, against a disposable source copy. No root dist/.
    execFileSync(process.execPath, [
        join(ROOT, "node_modules/typescript/bin/tsc"), "--noEmit", "false", "--outDir", "dist", "--rootDir", "src",
    ], { cwd: scratch, timeout: COMPILE_TIMEOUT_MS, stdio: "pipe" });
}, COMPILE_TIMEOUT_MS + 5_000);

afterEach(async () => {
    // Close the clients' sockets first, so that each server sees its client leave instead of being cut off.
    for (const agent of agents.splice(0)) agent.destroy();
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill();
            await exited;
        }
    }
});

afterAll(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

async function reservePort() {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        // Match app.listen(port)'s wildcard binding. A Windows loopback-only
        // reservation can coexist with an IPv6 wildcard listener on the same port.
        reservation.listen(0, resolve);
    });
    const address = reservation.address();
    if (address === null || typeof address === "string") throw new Error("No TCP port was reserved");
    return { reservation, port: address.port };
}

async function freePort(): Promise<number> {
    const { reservation, port } = await reservePort();
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    return port;
}

// The compiled server logs this line from its listen callback, so once it has appeared the port accepts connections.
function isListeningLine(line: string): boolean {
    try {
        return (JSON.parse(line) as { msg?: unknown }).msg === "server listening";
    } catch {
        return false;
    }
}

// Settles when the child logs that it is listening, and fails if it closes first or says nothing for too long.
// Nothing connects before then, so no request is spent on a port that is not open yet.
function untilAnnounced(child: ChildProcess, detail: () => string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(() => {
            reject(new Error(`no "server listening" line within ${STARTUP_TIMEOUT_MS} ms\n${detail()}`));
        }, STARTUP_TIMEOUT_MS);
        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
            if (stdout.split(/\r?\n/).some(isListeningLine)) {
                clearTimeout(timer);
                resolve();
            }
        });
        child.once("close", (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`the server exited (code ${code}, signal ${signal}) before it was listening\n${detail()}`));
        });
    });
}

function start(port: number, overrides: Record<string, string> = {}) {
    const env = { ...process.env };
    for (const variable of CONFIG_VARIABLES) delete env[variable];
    Object.assign(env, overrides, { PORT: String(port) });
    // The server never logs "server listening" at warn or error, so a child at either level also gets the preload
    // that prints it.
    const quiet = ["warn", "error"].includes(overrides.LOG_LEVEL ?? "");
    const child = spawn(process.execPath, [...(quiet ? ["--import", ANNOUNCE_LISTENING] : []), join(scratch, "dist/server.js")], {
        cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    // Every request of a test goes through this agent, which has one socket: see getFrom.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    // "close", not "exit": it comes after the last byte of the child's output, so stdout and stderr are complete.
    const exited = once(child, "close");
    const base = `http://127.0.0.1:${port}`;
    const detail = () => `stderr: ${stderr}`;
    const listening = untilAnnounced(child, detail);
    // A test that expects the server to fail never awaits this, and that must not be an unhandled rejection.
    listening.catch(() => undefined);
    return { child, exited, listening, stderr: () => stderr, base, agent };
}

type Started = ReturnType<typeof start>;
type Reply = { status: number; headers: IncomingHttpHeaders; text: string };

// A GET that reads the whole response. The server's agent has a single socket, so a request sent while the previous
// response is still being handed back to the pool waits for that socket and does not open another: a test makes one
// TCP connection however many requests it sends. fetch cannot promise that. It returns a finished connection to its
// pool one event-loop turn after the body has been read, and a request sent within that turn opens a second socket.
function getFrom(server: Started, path: string): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
        get(`${server.base}${path}`, { agent: server.agent }, (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => { text += chunk; });
            response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text }));
            response.once("error", reject);
        }).once("error", reject);
    });
}

// Starts the server on a port that was free a moment ago and waits until it is listening. Something else on the
// machine can claim that port in between, and the server then exits with EADDRINUSE. That says nothing about the
// server, so it is started again on a new port. Any other failure is a real failure and is rethrown at once.
async function startOnFreePort(overrides: Record<string, string> = {}): Promise<Started> {
    for (let attempt = 1; ; attempt++) {
        const server = start(await freePort(), overrides);
        try {
            await server.listening;
            return server;
        } catch (error) {
            if (server.child.exitCode === null) throw error;
            await server.exited;
            if (attempt === 3 || !server.stderr().includes("EADDRINUSE")) throw error;
        }
    }
}

// The one health request of a test, and its first connection. A server that is listening on some other port than
// PORT fails it with ECONNREFUSED here, which is how a server that ignores PORT is caught.
async function ready(server: Started) {
    const response = await getFrom(server, "/healthz");
    expect(response.status).toBe(200);
    return { headers: response.headers, body: JSON.parse(response.text) as unknown };
}

describe("QA — the compiled server really listens and consumes the process environment", () => {
    it("serves health and the documented version defaults from outside the repository working directory", async () => {
        const server = await startOnFreePort();
        const health = await ready(server);
        expect(health.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(health.body).toEqual({ status: "ok", uptimeSeconds: expect.any(Number) });
        const version = await getFrom(server, "/api/version");
        expect(JSON.parse(version.text)).toEqual({ version: "0.0.0-dev", commit: "unknown", environment: "local" });
        const page = await getFrom(server, "/");
        expect(page.status).toBe(200);
        expect(page.headers["content-type"]).toMatch(/^text\/html/);
        expect(page.text).toContain("<title>Widget Showcase</title>");
    }, TEST_TIMEOUT_MS);

    it("uses actual process labels rather than only an injected test configuration", async () => {
        const server = await startOnFreePort({
            APP_ENV: "qa-staging", APP_VERSION: "qa-build", GIT_COMMIT: "qa-revision", LOG_LEVEL: "warn",
        });
        await ready(server);
        const version = await getFrom(server, "/api/version");
        expect(JSON.parse(version.text)).toEqual({ version: "qa-build", commit: "qa-revision", environment: "qa-staging" });
    }, TEST_TIMEOUT_MS);

    it("starts with fallback labels and warns once per invalid variable in the real process", async () => {
        const invalid = {
            APP_ENV: " ", APP_VERSION: "", GIT_COMMIT: "\t", LOG_LEVEL: "loud", ENABLE_INSECURE_DEMO: "TRUE",
        };
        const server = await startOnFreePort(invalid);
        await ready(server);
        const version = await getFrom(server, "/api/version");
        expect(JSON.parse(version.text)).toEqual({ version: "0.0.0-dev", commit: "unknown", environment: "local" });
        // Count the warnings only once the process is gone: its "close" means every line it wrote has arrived.
        server.agent.destroy();
        server.child.kill();
        await server.exited;
        const lines = server.stderr().trim().split(/\r?\n/);
        expect(lines).toHaveLength(Object.keys(invalid).length);
        for (const variable of Object.keys(invalid)) {
            expect(lines.filter((line) => line.includes(`invalid ${variable}=`))).toHaveLength(1);
        }
    }, TEST_TIMEOUT_MS);

    it("exits nonzero on an occupied port instead of pretending it is serving", async () => {
        const { reservation, port } = await reservePort();
        try {
            const server = start(port);
            const [code] = await server.exited;
            expect(code).toBe(1);
            expect(server.stderr()).toContain("EADDRINUSE");
            expect(server.child.exitCode).toBe(1);
        } finally {
            await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
        }
    }, TEST_TIMEOUT_MS);
});
