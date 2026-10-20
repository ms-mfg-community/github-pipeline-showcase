// Run: node test/fixtures/run-workflows-delta-qa-mutations.mjs
// Candidate regressions remain red. Only disposable copies are changed, and every
// new assertion must be observed failing before this evidence runner can pass.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const path = "scripts/validate-workflows.mjs";
const original = readFileSync(join(root, path));
const scratch = mkdtempSync(join(tmpdir(), "wp2-delta-mutations-"));
const seenRed = new Set();

function run(label) {
    const result = spawnSync(process.execPath, [
        join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", root,
        "--pool=forks", "--maxWorkers=1", "--minWorkers=1", "--reporter=json",
        "test/workflows.delta.qa.test.ts",
    ], {
        cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, WP2_QA_ARTIFACT_ROOT: scratch },
    });
    assert.ifError(result.error);
    let report;
    try {
        report = JSON.parse(result.stdout);
    } catch {
        throw new Error(`Missing test evidence: exit=${result.status}\n${result.stdout}\n${result.stderr}`);
    }
    const tests = report.testResults.flatMap((file) => file.assertionResults);
    assert(tests.length > 0 && tests.every((test) => ["passed", "failed"].includes(test.status)));
    const failed = tests.filter((test) => test.status === "failed");
    assert.equal(result.status, failed.length ? 1 : 0, "A runner failure is not a killed mutant");
    for (const test of failed) {
        assert(test.failureMessages.some((message) => message.includes("AssertionError")), test.fullName);
        seenRed.add(test.fullName);
    }
    console.log(`${label}: exit=${result.status} passed=${tests.length - failed.length} failed=${failed.length}`);
    for (const test of failed) console.log(`  RED ${test.fullName}`);
    return { names: tests.map((test) => test.fullName), failed: failed.map((test) => test.fullName).sort() };
}

try {
    mkdirSync(join(scratch, "scripts"));
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(scratch, path), original);
    const candidate = run("CANDIDATE_CONTROL (red means a real unfixed regression)");
    const predecessor = spawnSync("git", ["--no-pager", "show", "9d6a64f:scripts/validate-workflows.mjs"], {
        cwd: root, encoding: "utf8",
    });
    assert.equal(predecessor.status, 0, predecessor.stderr);
    writeFileSync(join(scratch, path), predecessor.stdout);
    assert(run("REVERT_ROUND_2_FIX_IN_SCRATCH").failed.length > candidate.failed.length);

    const text = original.toString("utf8").replaceAll("\r\n", "\n");
    const target = "    const source = text.replace";
    assert(text.includes(target));
    writeFileSync(join(scratch, path), text.replace(target, `    return [];\n${target}`));
    assert(run("BYPASS_R1_R7_IN_SCRATCH").failed.length > 0);

    writeFileSync(join(scratch, path), original);
    assert.deepEqual(run("RESTORED_CANDIDATE").failed, candidate.failed);
    assert.deepEqual(candidate.names.filter((name) => !seenRed.has(name)), [], "A new test was never observed red");
    assert.deepEqual(readFileSync(join(root, path)), original, "The actual validator changed");
    console.log(`MUTATION_EVIDENCE ${candidate.names.length}/${candidate.names.length} tests observed red; ` +
        `candidate retains ${candidate.failed.length} failing regressions; actual validator unchanged; exit=0`);
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
