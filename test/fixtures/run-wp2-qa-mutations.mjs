// Run: node test/fixtures/run-wp2-qa-mutations.mjs
// Every product/test mutation is confined to a temporary copy. This runner is
// successful only when every new QA test has produced an assertion failure.
// Existing candidate regressions are recorded, never mistaken for green controls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "wp2-independent-qa-"));
const files = [
    "scripts/validate-workflows.mjs",
    ".github/dependabot.yml",
    ...["ci", "codeql", "dependency-review", "scorecard", "container-scan"].map((name) => `.github/workflows/${name}.yml`),
    ...["body-parser.delta.qa", "compression.delta.qa", "app", "app.contract.qa", "ui.qa"].map((name) => `test/${name}.test.ts`),
];
const original = new Map(files.map((path) => [path, readFileSync(join(root, path))]));
const seenRed = new Set();
let killed = 0;

function put(path, text) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), text);
}
function restore() {
    for (const [path, bytes] of original) put(path, bytes);
}
function change(path, from, to) {
    const text = original.get(path).toString("utf8").replaceAll("\r\n", "\n");
    assert(text.includes(from), `Missing mutation target in ${path}: ${from}`);
    put(path, text.replace(from, to));
}
function run(file, artifacts = scratch) {
    const proc = spawnSync(process.execPath, [
        join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", root,
        "--pool=forks", "--maxWorkers=1", "--minWorkers=1", "--reporter=json", file,
    ], {
        cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, WP2_QA_ARTIFACT_ROOT: artifacts, WP1_QA_ARTIFACT_ROOT: artifacts },
    });
    assert.ifError(proc.error);
    let report;
    try {
        report = JSON.parse(proc.stdout);
    } catch {
        throw new Error(`No test evidence: exit=${proc.status}\n${proc.stdout}\n${proc.stderr}`);
    }
    const tests = report.testResults.flatMap((result) => result.assertionResults);
    assert(tests.length > 0 && tests.every((test) => ["passed", "failed"].includes(test.status)), "Missing/unfinished assertions");
    const failed = tests.filter((test) => test.status === "failed");
    assert.equal(proc.status, failed.length ? 1 : 0, `A runner crash is not a test failure:\n${proc.stderr}`);
    for (const test of failed) {
        assert(test.failureMessages.some((message) => message.includes("AssertionError")), `Not an assertion failure: ${test.fullName}`);
        seenRed.add(test.fullName);
    }
    console.log(`RUN ${file}: exit=${proc.status} passed=${tests.length - failed.length} failed=${failed.length}`);
    return { names: tests.map((test) => test.fullName), failed: failed.map((test) => test.fullName) };
}
function mutant(label, file, mutate) {
    restore();
    mutate();
    console.log(`MUTANT ${label}`);
    try {
        const result = run(file);
        assert(result.failed.length > 0, "Mutant survived");
        killed += 1;
        return result;
    } finally {
        restore();
    }
}

try {
    for (const path of ["src", "public", "package.json", "tsconfig.json", "vitest.config.ts"]) {
        cpSync(join(root, path), join(scratch, path), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    restore();
    console.log(`SCRATCH=${scratch}`);
    const workflowFile = "test/workflows.qa.test.ts";
    const transportFile = "test/wp1-transport.qa.test.ts";
    console.log("BASELINE (nonzero here is a candidate defect, not a successful control)");
    const baseline = run(workflowFile);
    const transportBaseline = run(transportFile);
    assert.equal(transportBaseline.failed.length, 0, "Transport must start green before mutation");
    for (const name of baseline.failed) console.log(`BASELINE_RED ${name}`);

    mutant("bypass every R1-R7 rule", workflowFile, () => {
        change("scripts/validate-workflows.mjs", "    const source = text.replace", "    return [];\n    const source = text.replace");
    });
    mutant("invent a blocker for every valid workflow", workflowFile, () => {
        change("scripts/validate-workflows.mjs", "    const source = text.replace",
            '    return [{ line: 1, rule: "R1", message: "QA false-blocker mutant" }];\n    const source = text.replace');
    });
    mutant("remove specified workflow behaviors and Dependabot policy", workflowFile, () => {
        for (const name of ["ci", "codeql", "dependency-review", "scorecard", "container-scan"]) {
            put(`.github/workflows/${name}.yml`, "name: QA mutant\non: push\npermissions: {}\njobs: {}\n");
        }
        put(".github/dependabot.yml", "version: 2\nupdates: []\n");
    });
    mutant("remove keep-alive reuse from every stabilized HTTP suite", transportFile, () => {
        for (const path of files.filter((name) => name.startsWith("test/"))) {
            change(path, "new EndpointAgent({ keepAlive: true })", "new EndpointAgent({ keepAlive: false })");
        }
    });
    mutant("reintroduce synchronous compression inside a running test", transportFile, () => {
        change("test/compression.delta.qa.test.ts",
            "const good = CODECS.map(({ encoding, large }) => encoded(app, encoding, large));",
            "const good = CODECS.map(({ encoding, compress }) => encoded(app, encoding, compress(LARGE_VALID)));");
    });
    mutant("resolve a request before the server has finished with its response", transportFile, () => {
        change("test/app.test.ts",
            "end((error, response) => void Promise.all(unfinished).then(() => callback?.(error, response)));",
            "end((error, response) => callback?.(error, response));");
    });

    restore();
    console.log("RESTORED_BASELINE");
    const restored = run(workflowFile);
    const restoredTransport = run(transportFile);
    assert.deepEqual(restored.failed.slice().sort(), baseline.failed.slice().sort(), "Restoration changed candidate behavior");
    assert.equal(restoredTransport.failed.length, 0);
    const expected = [...baseline.names, ...transportBaseline.names];
    assert.deepEqual(expected.filter((name) => !seenRed.has(name)), [], "A new test was never observed failing");
    for (const [path, bytes] of original) {
        assert.deepEqual(readFileSync(join(root, path)), bytes, `Actual repository changed: ${path}`);
    }
    console.log(`MUTATION_EVIDENCE ${killed}/${killed} mutants killed; ${expected.length}/${expected.length} new tests observed red; ` +
        `restored candidate still has ${baseline.failed.length} regression(s); real files unchanged; exit=0`);
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
