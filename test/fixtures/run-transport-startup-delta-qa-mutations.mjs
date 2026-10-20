// Run: node test/fixtures/run-transport-startup-delta-qa-mutations.mjs
// Only disposable TEST copies are mutated. Every new startup/response-drain test must fail at an
// assertion against a broken helper, then pass again against the restored submitted helper.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "wp1-transport-startup-qa-"));
const originals = new Map(["test/app.test.ts", "test/server.qa.test.ts"].map((path) => [path, readFileSync(join(root, path))]));
const testFile = "test/transport-startup.delta.qa.test.ts";
const seenRed = new Set();
const cases = [
    {
        name: "publish the HTTP result before server-side completion",
        path: "test/app.test.ts",
        from: "end((error, response) => void Promise.all(unfinished).then(() => callback?.(error, response)));",
        to: "end((error, response) => callback?.(error, response));",
    },
    {
        name: "drop the client's completion callback",
        path: "test/app.test.ts",
        from: "callback?.(error, response)",
        to: "void 0",
    },
    {
        name: "accept unstructured or unrelated listening text",
        path: "test/server.qa.test.ts",
        from: 'return (JSON.parse(line) as { msg?: unknown }).msg === "server listening";',
        to: 'return line.includes("server listening");',
    },
    {
        name: "treat early child exit as successful startup",
        path: "test/server.qa.test.ts",
        from: 'reject(new Error(`the server exited (code ${code}, signal ${signal}) before it was listening\\n${detail()}`));',
        to: "resolve();",
    },
    {
        name: "treat startup silence as successful startup",
        path: "test/server.qa.test.ts",
        from: 'reject(new Error(`no "server listening" line within ${STARTUP_TIMEOUT_MS} ms\\n${detail()}`));',
        to: "resolve();",
    },
    {
        name: "probe the wrong port instead of the requested PORT",
        path: "test/server.qa.test.ts",
        from: "const base = `http://127.0.0.1:${port}`;",
        to: "const base = `http://127.0.0.1:${port + 1}`;",
    },
    {
        name: "start a quiet child without the preload that announces it",
        path: "test/server.qa.test.ts",
        from: '[...(quiet ? ["--import", ANNOUNCE_LISTENING] : []), join(scratch, "dist/server.js")]',
        to: '[join(scratch, "dist/server.js")]',
    },
    {
        name: "start every child with the preload, even one that logs the line itself",
        path: "test/server.qa.test.ts",
        from: 'const quiet = ["warn", "error"].includes(overrides.LOG_LEVEL ?? "");',
        to: "const quiet = true;",
    },
    {
        name: "let requests open a new socket each instead of sharing one keep-alive socket",
        path: "test/server.qa.test.ts",
        from: "new Agent({ keepAlive: true, maxSockets: 1 })",
        to: "new Agent({ keepAlive: false })",
    },
    {
        name: "send a request outside the server's own agent",
        path: "test/server.qa.test.ts",
        from: "{ agent: server.agent }",
        to: "{}",
    },
    {
        name: "announce when listen() is called instead of when the server is listening",
        path: "test/server.qa.test.ts",
        from: String.raw`this.once("listening", () => process.stdout.write(JSON.stringify({ msg: "server listening", port: this.address()?.port }) + "\\n"));`,
        to: String.raw`process.stdout.write(JSON.stringify({ msg: "server listening", port: this.address()?.port }) + "\\n");`,
    },
    {
        name: "announce with a line that start() does not recognise",
        path: "test/server.qa.test.ts",
        from: '{ msg: "server listening", port: this.address()?.port }',
        to: '{ msg: "listening", port: this.address()?.port }',
    },
    {
        name: "swallow the server's own listen call",
        path: "test/server.qa.test.ts",
        from: "return listen.apply(this, args);",
        to: "return this;",
    },
];

function restore() {
    for (const [path, bytes] of originals) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        writeFileSync(join(scratch, path), bytes);
    }
}

function run(label) {
    const result = spawnSync(process.execPath, [
        join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", root,
        "--pool=forks", "--maxWorkers=1", "--minWorkers=1", "--reporter=json", testFile,
    ], {
        cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, WP1_STARTUP_QA_ARTIFACT_ROOT: scratch },
    });
    assert.ifError(result.error);
    let report;
    try {
        report = JSON.parse(result.stdout);
    } catch {
        throw new Error(`No test evidence: exit=${result.status}\n${result.stdout}\n${result.stderr}`);
    }
    const tests = report.testResults.flatMap((file) => file.assertionResults);
    assert(tests.length > 0 && tests.every((test) => ["passed", "failed"].includes(test.status)), "Incomplete test execution");
    const failures = tests.filter((test) => test.status === "failed");
    assert.equal(result.status, failures.length ? 1 : 0, `Runner crash is not a killed mutant:\n${result.stderr}`);
    for (const test of failures) {
        assert(test.failureMessages.some((message) => message.includes("AssertionError")), `Not an assertion failure: ${test.fullName}`);
        seenRed.add(test.fullName);
    }
    console.log(`${label}: exit=${result.status} passed=${tests.length - failures.length} failed=${failures.length}`);
    for (const test of failures) console.log(`  RED ${test.fullName}: ${test.failureMessages[0]?.split("\n")[0]}`);
    return { names: tests.map((test) => test.fullName), failures };
}

try {
    restore();
    console.log(`SCRATCH=${scratch}`);
    const baseline = run("GREEN_CONTROL");
    assert.equal(baseline.failures.length, 0);
    for (const mutation of cases) {
        restore();
        const original = originals.get(mutation.path).toString("utf8").replaceAll("\r\n", "\n");
        assert(original.includes(mutation.from), `Missing mutation target: ${mutation.name}`);
        writeFileSync(join(scratch, mutation.path), original.replace(mutation.from, mutation.to));
        assert(run(`MUTANT ${mutation.name}`).failures.length > 0, "Mutant survived");
    }
    restore();
    assert.equal(run("RESTORED_GREEN_CONTROL").failures.length, 0);
    assert.deepEqual(baseline.names.filter((name) => !seenRed.has(name)), [], "A new QA test was never observed red");
    for (const [path, bytes] of originals) assert.deepEqual(readFileSync(join(root, path)), bytes, `Real test changed: ${path}`);
    console.log(`MUTATION_EVIDENCE ${cases.length}/${cases.length} mutants killed; ${baseline.names.length}/${baseline.names.length} new tests observed red; real files unchanged; exit=0`);
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
