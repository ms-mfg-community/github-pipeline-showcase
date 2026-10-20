// Run: node test/fixtures/run-body-parser-delta-mutations.mjs
// Red/green evidence for the WP1 round-2 delta. Product mutations are confined to a
// temporary copy; the real source, dependencies, and pre-built gate are never written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "wp1-body-parser-delta-"));
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const tests = ["test/app.test.ts", "test/app.contract.qa.test.ts", "test/body-parser.delta.qa.test.ts"];
const original = readFileSync(join(root, "src/app.ts"));

function run(pattern) {
    const args = [vitest, "run", "--root", scratch, "--reporter=json", ...tests];
    if (pattern) args.push("-t", pattern);
    const result = spawnSync(process.execPath, args, {
        cwd: scratch, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    let report;
    try {
        report = JSON.parse(result.stdout);
    } catch {
        throw new Error(`No parseable test evidence: ${result.stdout}\n${result.stderr}`);
    }
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    const failed = assertions.filter((test) => test.status === "failed");
    const passed = assertions.filter((test) => test.status === "passed");
    return { result, failed, passed };
}

function green(label) {
    const { result, failed, passed } = run();
    console.log(`${label} exit=${result.status} passed=${passed.length} failed=${failed.length}`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert(passed.length >= 13, "No meaningful green control was collected");
}

try {
    for (const path of ["src", "public", "package.json", "tsconfig.json", "vitest.config.ts", ...tests]) {
        cpSync(join(root, path), join(scratch, path), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    console.log(`SCRATCH=${scratch}`);
    green("GREEN_CONTROL");

    const oldApp = spawnSync("git", ["--no-pager", "show", "74e4f93:src/app.ts"], { cwd: root, encoding: "utf8" });
    assert.equal(oldApp.status, 0, oldApp.stderr);
    const cases = [
        {
            name: "round-1 source with the original 10 KiB cap",
            source: oldApp.stdout,
            pattern: "the POST contract applies|validity is decided|large valid JSON",
            minimumFailures: 11,
        },
        {
            name: "implicit body-parser 100 KiB default",
            from: "express.json({ limit: Infinity })", to: "express.json()",
            pattern: "validity is decided|large valid JSON", minimumFailures: 8,
        },
        {
            name: "large invalid fields incorrectly accepted",
            from: 'res.status(400).json({ error: "invalid_payload", details: result.details });',
            to: 'res.status(201).json({ error: "invalid_payload", details: result.details });',
            pattern: "invalid fields in large bodies|still rejects a name over 64", minimumFailures: 7,
        },
        {
            name: "large parser failures incorrectly mapped to 500",
            from: 'res.status(400).json({ error: "invalid_payload", details: [describeBodyError(err.type)] });',
            to: 'res.status(500).json({ error: "invalid_payload", details: [describeBodyError(err.type)] });',
            pattern: "large parser errors", minimumFailures: 2,
        },
        {
            name: "field validation rejection destroys accepted state",
            from: "if (!result.ok) {", to: "if (!result.ok) {\n            store.clear();",
            pattern: "invalid fields in large bodies", minimumFailures: 6,
        },
        {
            name: "parser rejection destroys accepted state",
            from: "if (isBodyParserError(err)) {", to: "if (isBodyParserError(err)) {\n            store.clear();",
            pattern: "large parser errors", minimumFailures: 2,
        },
    ];

    for (const mutation of cases) {
        const text = original.toString("utf8").replace(/\r\n/g, "\n");
        if (!mutation.source) assert(text.includes(mutation.from), `No mutation target: ${mutation.name}`);
        writeFileSync(join(scratch, "src/app.ts"), mutation.source ?? text.replace(mutation.from, mutation.to));
        try {
            const { result, failed, passed } = run(mutation.pattern);
            console.log(`MUTANT ${mutation.name}: exit=${result.status} failed=${failed.length} passed=${passed.length}`);
            for (const failure of failed) {
                console.log(`  RED ${failure.fullName}: ${failure.failureMessages[0]?.split("\n").slice(0, 2).join(" ")}`);
            }
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert(failed.length >= mutation.minimumFailures, "A collection/runner error is not a killed mutant");
        } finally {
            writeFileSync(join(scratch, "src/app.ts"), original);
        }
    }

    green("RESTORED_GREEN_CONTROL");
    assert.deepEqual(readFileSync(join(root, "src/app.ts")), original, "The actual product source changed");
    console.log(`MUTATION_EVIDENCE ${cases.length}/${cases.length} killed; source unchanged; exit=0`);
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
