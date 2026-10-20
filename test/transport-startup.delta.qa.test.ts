import { spawn as spawnChild } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { Agent } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

// Exercise the shipped test helpers themselves, not copies of their algorithms. Extracting named
// declarations avoids running the suites' beforeAll hooks or requiring a shared transport module.
// The real-process/real-IPC checks remain in server.qa.test.ts, server-connection.delta.qa.test.ts and
// wp1-transport.qa.test.ts. The one exception here is the preload that a quiet server child is started with:
// it is run in real Node processes below, because what it prints and when is the whole of its contract.
const repository = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = process.env.WP1_STARTUP_QA_ARTIFACT_ROOT ?? repository;

function declarations(path: string, names: string[]): string {
    const source = ts.createSourceFile(path, readFileSync(join(artifactRoot, path), "utf8"), ts.ScriptTarget.Latest, true);
    return names.map((name) => {
        const statement = source.statements.find((node) =>
            (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
            (ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) =>
                ts.isIdentifier(entry.name) && entry.name.text === name)),
        );
        if (statement === undefined) throw new Error(`Missing helper ${name} in ${path}`);
        return statement.getText(source);
    }).join("\n");
}

function execute<T>(source: string, globals: Record<string, unknown>): T {
    const javascript = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
    }).outputText;
    return runInNewContext(javascript, globals, { timeout: 1_000 }) as T;
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function observe(promise: Promise<unknown>) {
    const result: { state: "pending" | "fulfilled" | "rejected"; error?: unknown } = { state: "pending" };
    void promise.then(
        () => { result.state = "fulfilled"; },
        (error: unknown) => { result.state = "rejected"; result.error = error; },
    );
    return result;
}

class Child extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    exitCode: number | null = null;
    signalCode: string | null = null;
}
type Started = {
    child: Child;
    base: string;
    agent: Agent;
    listening: Promise<void>;
    exited: Promise<unknown>;
    stderr(): string;
};
type Timer = { at: number; callback: () => void };
type GetCall = { url: string; agent: unknown };
const SCRATCH = join(tmpdir(), "qa-not-a-real-server");
const disposals: Array<() => void> = [];
afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
});

function startup() {
    let clock = 0;
    let nextTimer = 0;
    const timers = new Map<number, Timer>();
    const children: Child[] = [];
    const agents: Agent[] = [];
    const calls: GetCall[] = [];
    const spawned: string[][] = [];
    let getError: Error | undefined;
    const source = declarations("test/server.qa.test.ts", [
        "CONFIG_VARIABLES", "STARTUP_TIMEOUT_MS", "ANNOUNCE_LISTENING", "isListeningLine", "untilAnnounced", "start", "getFrom", "ready",
    ]);
    const helpers = execute<{
        start(port: number, overrides?: Record<string, string>): Started;
        ready(server: Started): Promise<unknown>;
        isListeningLine(line: string): boolean;
        timeout: number;
        announce: string;
    }>(`${source}\n({ start, ready, isListeningLine, timeout: STARTUP_TIMEOUT_MS, announce: ANNOUNCE_LISTENING });`, {
        process: { env: {}, execPath: process.execPath },
        join, tmpdir, once, expect, children, agents, Agent, scratch: SCRATCH,
        setTimeout: (callback: () => void, milliseconds: number) => {
            const id = ++nextTimer;
            timers.set(id, { at: clock + milliseconds, callback });
            return id;
        },
        clearTimeout: (id: number) => { timers.delete(id); },
        spawn: (_command: string, args: string[]) => {
            spawned.push([...args]);
            return new Child();
        },
        // The request that getFrom sends: records where it went and which agent carried it, then answers it.
        get: (url: string, options: { agent: unknown }, callback: (response: EventEmitter) => void) => {
            calls.push({ url, agent: options.agent });
            const request = new EventEmitter();
            setImmediate(() => {
                if (getError !== undefined) {
                    request.emit("error", getError);
                    return;
                }
                const response = Object.assign(new EventEmitter(), {
                    statusCode: 200,
                    headers: { "content-type": "application/json; charset=utf-8" },
                    setEncoding: () => undefined,
                });
                callback(response);
                response.emit("data", '{"status":"ok","uptimeSeconds":1}');
                response.emit("end");
            });
            return request;
        },
    });
    disposals.push(() => {
        for (const agent of agents) agent.destroy();
        for (const child of children) {
            child.exitCode = 0;
            child.emit("close", 0, null);
            child.stdout.destroy();
            child.stderr.destroy();
        }
        timers.clear();
    });
    return {
        ...helpers, calls, timers, spawned, agents, scratch: SCRATCH,
        failGet(error: Error) { getError = error; },
        async advance() {
            const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            expect(entry, "A pending startup must have a bounded next wait").toBeDefined();
            if (entry === undefined) return;
            const [id, timer] = entry;
            timers.delete(id);
            clock = timer.at;
            timer.callback();
            await turn();
        },
    };
}

describe("QA — announced startup is event-driven and still verifies the requested port", () => {
    it("ignores noise and partial JSON, accepts fragmented stdout, and never connects before the announcement", async () => {
        const harness = startup();
        const server = harness.start(31_234);
        const result = observe(server.listening);
        server.child.stdout.write('not JSON: server listening\n{"msg":"other","detail":"server listening"}\n');
        server.child.stdout.write('{"msg":"server listen');
        await turn();
        expect(result.state).toBe("pending");
        expect(harness.calls).toEqual([]);
        expect(harness.timers.size).toBe(1);

        server.child.stdout.write('ing","port":31234}\r\n');
        await turn();
        expect(result.state).toBe("fulfilled");
        expect(harness.timers.size).toBe(0);
        expect(harness.calls).toEqual([]);
        await harness.ready(server);
        expect(harness.calls.map(({ url }) => url)).toEqual(["http://127.0.0.1:31234/healthz"]);
    });

    it("rejects early child exit with its diagnostic and cancels the startup timer", async () => {
        const harness = startup();
        const server = harness.start(31_234);
        const result = observe(server.listening);
        server.child.stderr.write("QA boot failed");
        server.child.exitCode = 1;
        server.child.emit("close", 1, null);
        await turn();
        expect(result.state).toBe("rejected");
        expect(String(result.error)).toContain("code 1");
        expect(String(result.error)).toContain("QA boot failed");
        expect(harness.timers.size).toBe(0);
        expect(harness.calls).toEqual([]);
    });

    it("rejects a child that never announces within the declared startup timeout", async () => {
        const harness = startup();
        const server = harness.start(31_234);
        const result = observe(server.listening);
        server.child.stderr.write("QA child stayed silent");
        expect([...harness.timers.values()].map(({ at }) => at)).toEqual([harness.timeout]);
        await harness.advance();
        expect(result.state).toBe("rejected");
        expect(String(result.error)).toContain(String(harness.timeout));
        expect(String(result.error)).toContain("QA child stayed silent");
        expect(harness.calls).toEqual([]);
    });

    it("does not substitute an announced wrong port or retry the requested-port health failure", async () => {
        const harness = startup();
        const server = harness.start(31_234);
        server.child.stdout.write('{"msg":"server listening","port":31235}\n');
        await turn();
        harness.failGet(new Error("QA ECONNREFUSED"));
        const result = observe(harness.ready(server));
        await turn();
        expect(result.state).toBe("rejected");
        expect(String(result.error)).toContain("ECONNREFUSED");
        expect(server.base).toBe("http://127.0.0.1:31234");
        expect(harness.calls.map(({ url }) => url)).toEqual(["http://127.0.0.1:31234/healthz"]);
    });
});

describe("QA — a quiet child announces itself through a preload, so nothing connects to find out", () => {
    it.each(["warn", "error"])("%s is started with the preload and is ready only once it has printed its line", async (level) => {
        const harness = startup();
        const server = harness.start(31_234, { LOG_LEVEL: level });
        expect(harness.spawned).toEqual([["--import", harness.announce, join(harness.scratch, "dist/server.js")]]);
        const result = observe(server.listening);
        await turn();
        expect(result.state).toBe("pending");
        expect(harness.calls).toEqual([]);
        // The startup ceiling is the only timer there is: nothing polls the port in the meantime.
        expect([...harness.timers.values()].map(({ at }) => at)).toEqual([harness.timeout]);

        server.child.stdout.write('{"msg":"server listening","port":31234}\n');
        await turn();
        expect(result.state).toBe("fulfilled");
        expect(harness.timers.size).toBe(0);
        expect(harness.calls).toEqual([]);
        await harness.ready(server);
        expect(harness.calls.map(({ url }) => url)).toEqual(["http://127.0.0.1:31234/healthz"]);
    });

    it.each([
        ["unset", undefined], ["debug", "debug"], ["info", "info"], ["an invalid value", "loud"],
    ])("a child with LOG_LEVEL %s logs the line itself and gets no preload", (_label, level) => {
        const harness = startup();
        harness.start(31_234, level === undefined ? {} : { LOG_LEVEL: level });
        expect(harness.spawned).toEqual([[join(harness.scratch, "dist/server.js")]]);
    });

    it.each(["warn", "error"])("%s: rejects a quiet child that exits before announcing, with its diagnostic and no connection", async (level) => {
        const harness = startup();
        const server = harness.start(31_234, { LOG_LEVEL: level });
        const result = observe(server.listening);
        server.child.stderr.write("QA quiet boot failed");
        server.child.exitCode = 1;
        server.child.emit("close", 1, null);
        await turn();
        expect(result.state).toBe("rejected");
        expect(String(result.error)).toContain("code 1");
        expect(String(result.error)).toContain("QA quiet boot failed");
        expect(harness.timers.size).toBe(0);
        expect(harness.calls).toEqual([]);
    });

    it.each(["warn", "error"])("%s: rejects a quiet child that stays silent past the startup timeout, with no connection", async (level) => {
        const harness = startup();
        const server = harness.start(31_234, { LOG_LEVEL: level });
        const result = observe(server.listening);
        server.child.stderr.write("QA quiet child stayed silent");
        await harness.advance();
        expect(result.state).toBe("rejected");
        expect(String(result.error)).toContain(String(harness.timeout));
        expect(String(result.error)).toContain("QA quiet child stayed silent");
        expect(harness.timers.size).toBe(0);
        expect(harness.calls).toEqual([]);
    });

    it("sends every request of a server over that server's own single-socket keep-alive agent", async () => {
        const harness = startup();
        const first = harness.start(31_234);
        const second = harness.start(31_235);
        for (const server of [first, second]) server.child.stdout.write(`{"msg":"server listening","port":${server === first ? 31_234 : 31_235}}\n`);
        await turn();
        await harness.ready(first);
        await harness.ready(first);
        await harness.ready(second);
        expect(harness.calls.map(({ url }) => url)).toEqual([
            "http://127.0.0.1:31234/healthz", "http://127.0.0.1:31234/healthz", "http://127.0.0.1:31235/healthz",
        ]);
        expect(harness.calls.map(({ agent }) => agent)).toEqual([first.agent, first.agent, second.agent]);
        expect(first.agent).not.toBe(second.agent);
        // One socket per agent is what makes the connection count a guarantee instead of a matter of timing.
        for (const agent of [first.agent, second.agent]) expect(agent).toMatchObject({ keepAlive: true, maxSockets: 1 });
    });
});

// What the preload prints, and when, is its whole contract, so it is run for real: a Node process that loads it and
// then starts an HTTP server. Nothing here makes a TCP connection; the server only listens. Starting a Node process
// can take many seconds when every CPU is busy, so the tests that do it get the server suite's ceiling, not the default.
const PROCESS_TIMEOUT_MS = 60_000;
function preloaded(announce: string, script: string, env: Record<string, string> = {}) {
    const child = spawnChild(process.execPath, ["--import", announce, "-"], {
        env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    // A child that outlives its test (a timeout, say) must not outlive the file.
    disposals.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    // The script goes in on stdin, which keeps quotes and newlines clear of the Windows command line.
    child.stdin.end(script);
    return once(child, "close").then(([status]) => ({
        status: status as number | null,
        lines: stdout.split(/\r?\n/).filter((line) => line !== ""),
        stderr,
    }));
}

describe("QA — the preload announces the server's own listening event and nothing else", () => {
    it("prints its line when the server really listens: after listen() returned, before the listen callback, with the bound port", async () => {
        const harness = startup();
        const run = await preloaded(harness.announce, [
            'const { createServer } = require("node:http");',
            'const say = (text) => process.stdout.write(text + "\\n");',
            'say("before listen");',
            "const server = createServer();",
            'server.listen(0, () => { say("listen callback " + server.address().port); server.close(); });',
            'say("listen returned");',
        ].join("\n"));
        expect(run.status, run.stderr).toBe(0);
        const port = Number(/^listen callback (\d+)$/.exec(run.lines[3] ?? "")?.[1]);
        expect(port).toBeGreaterThan(0);
        expect(run.lines).toEqual([
            "before listen", "listen returned", `{"msg":"server listening","port":${port}}`, `listen callback ${port}`,
        ]);
        // It is the line that start() waits for.
        expect(harness.isListeningLine(run.lines[2] ?? "")).toBe(true);
    }, PROCESS_TIMEOUT_MS);

    it("prints nothing when the server fails to listen", async () => {
        const harness = startup();
        const reservation = createNetServer();
        await new Promise<void>((resolve, reject) => {
            reservation.once("error", reject);
            reservation.listen(0, resolve);
        });
        try {
            const address = reservation.address();
            expect(address).toMatchObject({ port: expect.any(Number) });
            const run = await preloaded(harness.announce, [
                'const { createServer } = require("node:http");',
                "const server = createServer();",
                'server.once("error", (error) => process.stdout.write("listen failed " + error.code + "\\n"));',
                "server.listen(Number(process.env.QA_PORT));",
            ].join("\n"), { QA_PORT: String((address as { port: number }).port) });
            expect(run.status, run.stderr).toBe(0);
            expect(run.lines).toEqual(["listen failed EADDRINUSE"]);
        } finally {
            await new Promise<void>((resolve) => reservation.close(() => resolve()));
        }
    }, PROCESS_TIMEOUT_MS);
});

type WireResponse = { status: number };
type EndCallback = (error: Error | null, response?: WireResponse) => void;
type Endable = { end(callback: EndCallback): Endable };
function responseDrain() {
    const unfinished = new Set<Promise<void>>();
    const afterServer = execute<(test: Endable) => Endable>(
        `${declarations("test/app.test.ts", ["afterServer"])}\nafterServer;`,
        { unfinished, Promise },
    );
    let wireCallback: EndCallback | undefined;
    const test: Endable = { end(callback) { wireCallback = callback; return this; } };
    return {
        test: afterServer(test),
        hold() {
            let release!: () => void;
            const pending = new Promise<void>((resolve) => { release = resolve; });
            unfinished.add(pending);
            return release;
        },
        respond(error: Error | null, response?: WireResponse) {
            expect(wireCallback).toBeDefined();
            wireCallback?.(error, response);
        },
    };
}

describe("QA — client completion cannot outrun server response completion and access logging", () => {
    it("waits for every unfinished response before publishing a successful result", async () => {
        const harness = responseDrain();
        const first = harness.hold();
        const second = harness.hold();
        const completed: unknown[] = [];
        expect(harness.test.end((error, response) => { completed.push([error, response]); })).toBe(harness.test);
        const response = { status: 200 };
        harness.respond(null, response);
        await turn();
        expect(completed).toEqual([]);
        first();
        await turn();
        expect(completed).toEqual([]);
        second();
        await turn();
        expect(completed).toEqual([[null, response]]);
    });

    it("preserves a transport error while still waiting for server-side completion", async () => {
        const harness = responseDrain();
        const release = harness.hold();
        const error = new Error("QA ECONNRESET");
        const completed: unknown[] = [];
        harness.test.end((failure, response) => { completed.push([failure, response]); });
        harness.respond(error);
        await turn();
        expect(completed).toEqual([]);
        release();
        await turn();
        expect(completed).toEqual([[error, undefined]]);
    });

    it("completes exactly once when the response has already drained", async () => {
        const harness = responseDrain();
        const completed: unknown[] = [];
        harness.test.end((error, response) => { completed.push([error, response]); });
        const response = { status: 404 };
        harness.respond(null, response);
        await turn();
        await turn();
        expect(completed).toEqual([[null, response]]);
    });
});
