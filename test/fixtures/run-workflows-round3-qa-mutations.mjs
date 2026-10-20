// Run: node test/fixtures/run-workflows-round3-qa-mutations.mjs
// The production tree is never changed. The new tests must first pass against
// the candidate, each must produce an assertion failure against a broken copy,
// and the restored candidate must pass again.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const path = "scripts/validate-workflows.mjs";
const original = readFileSync(join(root, path));
const scratch = mkdtempSync(join(tmpdir(), "wp2-round3-mutations-"));
const seenRed = new Set();

function run(label) {
    const result = spawnSync(process.execPath, [
        join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", root,
        "--pool=forks", "--maxWorkers=1", "--minWorkers=1", "--reporter=json",
        "test/workflows.round3.qa.test.ts",
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
    return { names: tests.map((test) => test.fullName), failed: failed.map((test) => test.fullName) };
}

try {
    mkdirSync(join(scratch, "scripts"));
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(scratch, path), original);
    const candidate = run("GREEN_CANDIDATE");
    assert.equal(candidate.failed.length, 0, "The candidate has an actual regression");

    const predecessor = spawnSync("git", ["--no-pager", "show", "1b86a57:scripts/validate-workflows.mjs"], {
        cwd: root, encoding: "utf8",
    });
    assert.equal(predecessor.status, 0, predecessor.stderr);
    writeFileSync(join(scratch, path), predecessor.stdout);
    assert(run("REVERT_ROUND_3_FIX_IN_SCRATCH").failed.length > 0);

    const text = original.toString("utf8").replaceAll("\r\n", "\n");
    const readingPoints = "    function readingPoints(node) {";
    assert(text.includes(readingPoints));
    writeFileSync(join(scratch, path), text.replace(readingPoints, `${readingPoints}\n        return [];`));
    assert(run("LOSE_ALL_COMMENT_POSITIONS_IN_SCRATCH").failed.length > 0);

    const rules = "    const source = text.replace";
    assert(text.includes(rules));
    writeFileSync(join(scratch, path), text.replace(rules, `    return [];\n${rules}`));
    assert(run("BYPASS_R1_R7_IN_SCRATCH").failed.length > 0);

    writeFileSync(join(scratch, path), original);
    assert.equal(run("RESTORED_GREEN_CANDIDATE").failed.length, 0);
    assert.deepEqual(candidate.names.filter((name) => !seenRed.has(name)), [], "A new test was never observed red");
    assert.deepEqual(readFileSync(join(root, path)), original, "The production validator changed");
    console.log(`MUTATION_EVIDENCE 3/3 mutants killed; ${candidate.names.length}/${candidate.names.length} tests observed red; ` +
        "restored candidate green; production validator unchanged; exit=0");
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
