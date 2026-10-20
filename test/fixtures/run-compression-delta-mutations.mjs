// Run: node test/fixtures/run-compression-delta-mutations.mjs
// Round-3 red/green evidence. Only a disposable source copy is mutated; the real
// product files, dependencies, and pre-built gate remain byte-for-byte unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "wp1-compression-delta-"));
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const tests = ["test/compression.delta.qa.test.ts", "test/app.test.ts"];
const selection = "QA round 3|a body that cannot be decompressed";
const original = readFileSync(join(root, "src/app.ts"));
const text = original.toString("utf8").replace(/\r\n/g, "\n");
const seenRed = new Set();

function run(pattern = selection, expectedCount = 37) {
    const result = spawnSync(process.execPath, [
        vitest, "run", "--root", scratch, "--reporter=json",
        "--pool=threads", "--maxWorkers=1", "--minWorkers=1", ...tests, "-t", pattern,
    ], { cwd: scratch, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    let report;
    try {
        report = JSON.parse(result.stdout);
    } catch {
        throw new Error(`No parseable test evidence: exit=${result.status} signal=${result.signal}\n${result.stdout}\n${result.stderr}`);
    }
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    const failed = assertions.filter((test) => test.status === "failed");
    const passed = assertions.filter((test) => test.status === "passed");
    if (failed.length + passed.length !== expectedCount) {
        console.error(`INCOMPLETE_RUN exit=${result.status} passed=${passed.length} failed=${failed.length}`);
        console.error(result.stderr);
        console.error(JSON.stringify(report.testResults.map((file) => ({
            name: file.name, status: file.status, message: file.message,
            completed: file.assertionResults.filter((test) => test.status === "passed" || test.status === "failed").length,
        }))));
    }
    assert.equal(failed.length + passed.length, expectedCount, "Every selected assertion must actually run");
    assert(!`${result.stdout}\n${result.stderr}`.includes("Worker exited unexpectedly"), "A runner crash is not a killed mutant");
    return { result, failed, passed };
}

function green(label) {
    const evidence = run();
    console.log(`${label} exit=${evidence.result.status} passed=${evidence.passed.length} failed=${evidence.failed.length}`);
    assert.equal(evidence.result.status, 0, evidence.result.stdout + evidence.result.stderr);
    return evidence.passed.map((test) => test.fullName);
}

function replace(from, to) {
    assert(text.includes(from), `Missing mutation target: ${from}`);
    return text.replace(from, to);
}

try {
    for (const path of ["src", "public", "package.json", "tsconfig.json", "vitest.config.ts", ...tests]) {
        cpSync(join(root, path), join(scratch, path), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    console.log(`SCRATCH=${scratch}`);
    const expected = green("GREEN_CONTROL");
    const predecessor = spawnSync("git", ["--no-pager", "show", "b40b70a:src/app.ts"], { cwd: root, encoding: "utf8" });
    assert.equal(predecessor.status, 0, predecessor.stderr);

    const uriFirst = /if \(err instanceof URIError\) \{[\s\S]*?res\.status\(404\)\.json\(NOT_FOUND\);\n\s*\} else if \(isBodyParserError\(err\)\) \{\n\s*res\.status\(400\)\.json\(\{ error: "invalid_payload", details: \[describeBodyError\(err\.type\)\] \}\);\n\s*\}/;
    assert(uriFirst.test(text), "URIError ordering mutation must match the actual handler");
    const cases = [
        {
            name: "restore the real pre-fix string-type requirement",
            source: predecessor.stdout,
            pattern: "cannot be decompressed|returns 400 and recovers|concurrent decoded",
            expectedCount: 15, minimumFailures: 14,
        },
        {
            name: "restore body-parser's implicit 100 KiB cap",
            source: replace("express.json({ limit: Infinity })", "express.json()"),
            pattern: "accepts large valid|concurrent decoded",
            expectedCount: 4, minimumFailures: 4,
        },
        {
            name: "let the broad 4xx check misclassify URIError",
            source: text.replace(uriFirst, `if (isBodyParserError(err)) {
            res.status(400).json({ error: "invalid_payload", details: [describeBodyError(err.type)] });
        } else if (err instanceof URIError) {
            res.status(404).json(NOT_FOUND);
        }`),
            pattern: "undecodable id",
            expectedCount: 6, minimumFailures: 6,
        },
        {
            name: "map parser failures to 500 instead of 400",
            source: replace(
                'res.status(400).json({ error: "invalid_payload", details: [describeBodyError(err.type)] });',
                'res.status(500).json({ error: "invalid_payload", details: [describeBodyError(err.type)] });',
            ),
            pattern: "malformed decoded JSON",
            expectedCount: 3, minimumFailures: 3,
        },
        {
            name: "accept invalid decoded fields as a successful creation",
            source: replace(
                'res.status(400).json({ error: "invalid_payload", details: result.details });',
                'res.status(201).json({ error: "invalid_payload", details: result.details });',
            ),
            pattern: "invalid decoded fields",
            expectedCount: 3, minimumFailures: 3,
        },
        {
            name: "erase accepted state while handling a parser rejection",
            source: replace("if (isBodyParserError(err)) {", "if (isBodyParserError(err)) {\n            store.clear();"),
            pattern: "returns 400 and recovers|malformed decoded JSON|concurrent decoded",
            expectedCount: 13, minimumFailures: 13,
        },
        {
            name: "erase accepted state while handling a field rejection",
            source: replace("if (!result.ok) {", "if (!result.ok) {\n            store.clear();"),
            pattern: "invalid decoded fields",
            expectedCount: 3, minimumFailures: 3,
        },
        {
            name: "parse bodies globally instead of on POST widgets only",
            source: replace('app.disable("x-powered-by");', 'app.disable("x-powered-by");\n    app.use(express.json({ limit: Infinity }));'),
            pattern: "ignores a body that falsely claims gzip",
            expectedCount: 7, minimumFailures: 7,
        },
        {
            name: "reject genuinely compressed JSON by disabling inflation",
            source: replace("express.json({ limit: Infinity })", "express.json({ limit: Infinity, inflate: false })"),
            pattern: "accepts large valid|still accepts a body that really is gzip-compressed",
            expectedCount: 4, minimumFailures: 4,
        },
    ];

    for (const mutation of cases) {
        writeFileSync(join(scratch, "src/app.ts"), mutation.source);
        try {
            const { result, failed, passed } = run(mutation.pattern, mutation.expectedCount);
            console.log(`MUTANT ${mutation.name}: exit=${result.status} failed=${failed.length} passed=${passed.length}`);
            for (const failure of failed) {
                seenRed.add(failure.fullName);
                console.log(`  RED ${failure.fullName}: ${failure.failureMessages[0]?.split("\n").slice(0, 2).join(" ")}`);
            }
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert(failed.length >= mutation.minimumFailures, "Missing expected failing assertions");
        } finally {
            writeFileSync(join(scratch, "src/app.ts"), original);
        }
    }

    const missing = expected.filter((name) => !seenRed.has(name));
    assert.deepEqual(missing, [], "Every new QA test and every changed developer test must be observed red");
    green("RESTORED_GREEN_CONTROL");
    assert.deepEqual(readFileSync(join(root, "src/app.ts")), original, "The actual product source changed");
    console.log(`MUTATION_EVIDENCE ${cases.length}/${cases.length} killed; 37/37 tests observed red; 32/32 new QA tests observed red; real source unchanged; exit=0`);
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
