// Run: node test/fixtures/run-server-connection-delta-qa-mutations.mjs
// Proves that test/server-connection.delta.qa.test.ts fails for the two defects it guards against. Only a disposable
// copy of test/server.qa.test.ts is ever mutated. The submitted suite must pass all tests, and each mutant must fail
// one of them at a connection-count assertion, not merely crash or time out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "wp1-server-connection-qa-"));
const target = "test/server.qa.test.ts";
const original = readFileSync(join(root, target));
const file = "test/server-connection.delta.qa.test.ts";
const seenRed = new Set();
const mutants = [
    {
        // Every request on its own socket: the connection count the suite is meant to hold at one per server.
        name: "open a new connection for every request",
        edits: [["new Agent({ keepAlive: true, maxSockets: 1 })", "new Agent({ keepAlive: false })"]],
    },
    {
        // The old behaviour: do not wait for a quiet child to announce itself, and keep asking its port until it
        // answers. Every assertion of the server suite still passes, because the retries hide the refused connects.
        name: "retry a quiet child's first request until its port answers instead of waiting for it to announce",
        edits: [
            ["const listening = untilAnnounced(child, detail);", "const listening = quiet ? Promise.resolve() : untilAnnounced(child, detail);"],
            [
                'const response = await getFrom(server, "/healthz");',
                `let response: Reply | undefined;
    while (response === undefined) {
        try { response = await getFrom(server, "/healthz"); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }`,
            ],
        ],
    },
];

function put(text) {
    mkdirSync(dirname(join(scratch, target)), { recursive: true });
    writeFileSync(join(scratch, target), text);
}

function mutate(edits) {
    let text = original.toString("utf8").replaceAll("\r\n", "\n");
    for (const [from, to] of edits) {
        assert(text.includes(from), `Missing mutation target: ${from}`);
        text = text.replace(from, () => to);
    }
    put(text);
}

function run(label) {
    const child = spawnSync(process.execPath, [
        join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", root,
        "--pool=forks", "--maxWorkers=1", "--minWorkers=1", "--reporter=json", file,
    ], {
        cwd: root, encoding: "utf8", timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, WP1_SERVER_CONNECTION_ARTIFACT_ROOT: scratch },
    });
    assert.ifError(child.error);
    let report;
    try {
        report = JSON.parse(child.stdout);
    } catch {
        throw new Error(`Missing test evidence: exit=${child.status}\n${child.stdout}\n${child.stderr}`);
    }
    const tests = report.testResults.flatMap((entry) => entry.assertionResults);
    assert.equal(tests.length, 3);
    assert(tests.every((test) => ["passed", "failed"].includes(test.status)), "Incomplete test execution");
    const failed = tests.filter((test) => test.status === "failed");
    assert.equal(child.status, failed.length ? 1 : 0, `Runner failure is not evidence:\n${child.stderr}`);
    for (const test of failed) {
        assert(test.failureMessages.some((message) => message.includes("AssertionError")), test.fullName);
        assert(test.failureMessages.some((message) =>
            message.includes("Successful TCP connections per serving test") || message.includes("TCP attempts")),
        "An unrelated failure is not connection evidence");
        seenRed.add(test.fullName);
        console.log(`  RED ${test.fullName}: ${test.failureMessages[0]?.split("\n")[0]}`);
    }
    console.log(`${label}: exit=${child.status} passed=${tests.length - failed.length} failed=${failed.length}`);
    return failed.length;
}

try {
    for (const path of ["src", "public", "package.json", "tsconfig.json", "vitest.config.ts"]) {
        cpSync(join(root, path), join(scratch, path), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    console.log(`SCRATCH=${scratch}`);
    put(original);
    assert.equal(run("SUBMITTED_SUITE"), 0, "The submitted server suite must satisfy every connection test");
    for (const mutant of mutants) {
        mutate(mutant.edits);
        assert(run(`MUTANT ${mutant.name}`) > 0, "Mutant survived");
    }
    put(original);
    assert.equal(run("RESTORED_SUITE"), 0);
    assert.equal(seenRed.size, 3, "Every connection test must be observed red");
    assert.deepEqual(readFileSync(join(root, target)), original, "Actual server suite changed");
    console.log(`MUTATION_EVIDENCE ${mutants.length}/${mutants.length} mutants killed; 3/3 connection tests observed red; ` +
        "submitted suite green before and after; real files unchanged; exit=0");
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
