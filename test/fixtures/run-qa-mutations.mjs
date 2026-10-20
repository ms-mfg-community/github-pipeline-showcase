// Reproducible QA evidence: node test/fixtures/run-qa-mutations.mjs
// Mutate disposable copies ONLY. Neither tracked product files nor node_modules
// are ever written. The three known-red body-size regressions run in the gate,
// not in this green-control matrix.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "showcase-wp1-qa-mutants-"));
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const python = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const originals = new Map();
const cases = [
    {
        name: "concurrent deletes must actually remove exactly one widget",
        file: "src/widgets.ts", from: "return this.widgets.delete(id);", to: "return false;",
        tests: ["test/app.contract.qa.test.ts"], pattern: "stores every concurrent creation",
    },
    {
        name: "parser rejection must preserve accepted state",
        file: "src/app.ts", from: "if (isBodyParserError(err)) {", to: "if (isBodyParserError(err)) {\n            store.clear();",
        tests: ["test/app.contract.qa.test.ts"], pattern: "recovers from a parser rejection",
    },
    {
        name: "all four malformed unmatched-route callers must remain JSON 404",
        file: "src/app.ts",
        from: 'app.use((_req, res) => {\n        res.status(404).json(NOT_FOUND);',
        to: 'app.use((_req, res) => {\n        res.status(200).json(NOT_FOUND);',
        tests: ["test/app.contract.qa.test.ts"], pattern: "remains an unmatched JSON 404", minimumFailures: 4,
    },
    {
        name: "the page must render the fetched version",
        file: "public/index.html",
        from: '$("version").textContent = "Version " + info.version + " · commit " + info.commit + " · environment " + info.environment;',
        to: '$("version").textContent = "not rendered";',
        tests: ["test/ui.qa.test.ts"], pattern: "renders version labels",
    },
    {
        name: "the page must reveal the empty list, including after deletion",
        file: "public/index.html", from: '$("empty").hidden = items.length > 0;', to: '$("empty").hidden = true;',
        tests: ["test/ui.qa.test.ts"], pattern: "renders an empty-state|deletes the selected widget", minimumFailures: 2,
    },
    {
        name: "submitting the form must perform a write, not only read",
        file: "public/index.html", from: 'method: "POST",', to: 'method: "GET",',
        tests: ["test/ui.qa.test.ts"], pattern: "submits numeric quantities",
    },
    {
        name: "the delete button must remove server state",
        file: "public/index.html",
        from: 'await api("/api/widgets/" + encodeURIComponent(widget.id), { method: "DELETE" });',
        to: 'await api("/api/widgets");',
        tests: ["test/ui.qa.test.ts"], pattern: "deletes the selected widget",
    },
    {
        name: "an empty quantity must remain missing, not silently become zero",
        file: "public/index.html",
        from: 'quantity: quantity === "" ? undefined : Number(quantity)',
        to: 'quantity: Number(quantity)',
        tests: ["test/ui.qa.test.ts"], pattern: "surfaces validation details for a missing quantity",
    },
    {
        name: "the page must show a failed request",
        file: "public/index.html",
        from: '$("error").textContent = (error.details && error.details.length ? error.details : [error.message]).join("; ");',
        to: '$("error").textContent = "";',
        tests: ["test/ui.qa.test.ts"], pattern: "shows a network failure",
    },
    {
        name: "the compiled server must really honor PORT",
        file: "src/server.ts", from: "app.listen(config.port,", to: "app.listen(config.port + 1,",
        tests: ["test/server.qa.test.ts"], pattern: "serves health and the documented version defaults",
    },
    {
        name: "the compiled server must expose actual environment labels",
        file: "src/app.ts",
        from: "res.json({ version: config.appVersion, commit: config.gitCommit, environment: config.appEnv });",
        to: 'res.json({ version: "0.0.0-dev", commit: "unknown", environment: "local" });',
        tests: ["test/server.qa.test.ts"], pattern: "uses actual process labels",
    },
    {
        name: "invalid config must warn once in both unit and process callers",
        file: "src/config.ts", from: "warn(`Ignoring invalid", to: "void (`Ignoring invalid",
        tests: ["test/server.qa.test.ts", "test/config.test.ts"],
        pattern: "invalid variable in the real process|exactly one warning", minimumFailures: 25,
    },
    {
        name: "a failed listen must not report process success",
        file: "src/server.ts", from: "process.exit(1);", to: "process.exit(0);",
        tests: ["test/server.qa.test.ts"], pattern: "exits nonzero on an occupied port",
    },
    {
        name: "healthz must carry the contract status",
        file: "src/app.ts", from: 'res.json({ status: "ok", uptimeSeconds:', to: 'res.json({ status: "broken", uptimeSeconds:',
        tests: ["test/app.test.ts"], pattern: "numeric uptimeSeconds",
    },
    {
        name: "the list response must contain an array",
        file: "src/app.ts", from: "res.json({ items: store.list() });", to: 'res.json({ items: "not an array" });',
        tests: ["test/app.test.ts"], pattern: "GET /api/widgets", minimumFailures: 2,
    },
    {
        name: "GET by id must return the stored widget",
        file: "src/app.ts", from: "res.json(widget);", to: "res.json({});",
        tests: ["test/app.test.ts"], pattern: "returns 200 with the widget",
    },
    {
        name: "successful creation must return 201",
        file: "src/app.ts", from: "res.status(201).json", to: "res.status(200).json",
        tests: ["test/app.test.ts"], pattern: "returns 201 with the created widget",
    },
    {
        name: "every validation failure must retain invalid_payload",
        file: "src/app.ts", from: 'error: "invalid_payload", details: result.details', to: 'error: "wrong_code", details: result.details',
        tests: ["test/app.test.ts"], pattern: "validation failures return 400", minimumFailures: 15,
    },
    {
        name: "HTTP delete must not be cosmetic",
        file: "src/app.ts", from: "if (!store.delete(req.params.id)) {", to: "if (false) {",
        tests: ["test/app.test.ts"], pattern: "DELETE /api/widgets/:id", minimumFailures: 4,
    },
    {
        name: "GET root must serve the shipped HTML artifact",
        file: "src/app.ts", from: 'res.type("html").send(indexHtml);', to: 'res.type("html").send("<p>not the page</p>");',
        tests: ["test/app.test.ts"], pattern: "returns 200 with public/index.html",
    },
    {
        name: "config defaults must not drift with the implementation",
        file: "src/config.ts", from: "port: 3000,", to: "port: 3001,",
        tests: ["test/config.test.ts"], pattern: "loadConfig — defaults", minimumFailures: 2,
    },
    {
        name: "the domain name bound must remain 64",
        file: "src/widgets.ts", from: "NAME_MAX_LENGTH = 64;", to: "NAME_MAX_LENGTH = 65;",
        tests: ["test/widgets.test.ts"], pattern: "boundaries|65 characters", minimumFailures: 3,
    },
    {
        name: "store return values must not expose mutable stored state",
        file: "src/widgets.ts", from: "return { ...widget };", to: "return widget;",
        tests: ["test/widgets.test.ts"], pattern: "hands out copies",
    },
    {
        name: "report fetch must return the received JSON",
        file: "tools/report.py", from: "return response.json()", to: "return {}",
        python: true, pattern: "test_fetch_returns_the_json_body",
    },
    {
        name: "report fetch must reject HTTP errors",
        file: "tools/report.py", from: "response.raise_for_status()", to: "pass",
        python: true, pattern: "test_fetch_lets_an_http_error",
    },
    {
        name: "both HTTP and HTTPS sources must reach requests",
        file: "tools/report.py", from: 'if source.startswith(("http://", "https://")):', to: "if False:",
        python: true, pattern: "test_read_fetches_http_and_https_urls", minimumFailures: 2,
    },
    {
        name: "the report CLI must print the records rather than a success label",
        file: "tools/report.py", from: "print(summarize(read(raw)))", to: 'print("succeeded")',
        python: true, pattern: "test_main_prints_one_summary_line_per_record",
    },
];

function runNode(tests, pattern) {
    const args = [vitest, "run", "--root", scratch, "--reporter=json", ...tests, "-t", pattern];
    const result = spawnSync(process.execPath, args, { cwd: scratch, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    let report;
    try {
        report = JSON.parse(result.stdout);
    } catch {
        throw new Error(`No Vitest evidence: ${result.stdout}\n${result.stderr}`);
    }
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    return { result, assertions, failures: assertions.filter((test) => test.status === "failed") };
}

let killed = 0;
try {
    // The whole suite is the green control, so the WP2 workflow tests need the scripts and workflows they read.
    for (const path of ["src", "public", "test", "tools", "scripts", ".github", "package.json", "tsconfig.json", "vitest.config.ts"]) {
        cpSync(join(root, path), join(scratch, path), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    console.log("SCRATCH=" + scratch);
    const control = runNode([], "^(?!.*the POST contract applies)");
    console.log(`NODE_GREEN_CONTROL exit=${control.result.status} passed=${control.assertions.filter((test) => test.status === "passed").length} known-red-excluded=3`);
    assert.equal(control.result.status, 0, control.result.stdout + control.result.stderr);
    const pyControl = spawnSync(python, ["-m", "pytest", "tools", "-q"], { cwd: scratch, encoding: "utf8", timeout: 30_000 });
    console.log(`PYTHON_GREEN_CONTROL exit=${pyControl.status} ${pyControl.stdout.trim()}`);
    assert.equal(pyControl.status, 0, pyControl.stdout + pyControl.stderr);

    for (const mutation of cases) {
        const sourcePath = join(scratch, mutation.file);
        const before = readFileSync(sourcePath);
        if (!originals.has(mutation.file)) originals.set(mutation.file, readFileSync(join(root, mutation.file)));
        const text = before.toString("utf8").replace(/\r\n/g, "\n");
        assert(text.includes(mutation.from), `Mutation no longer matches ${mutation.file}: ${mutation.name}`);
        writeFileSync(sourcePath, text.replace(mutation.from, mutation.to));
        try {
            if (mutation.python) {
                const result = spawnSync(python, ["-m", "pytest", "tools/test_report.py", "-q", "-k", mutation.pattern], {
                    cwd: scratch, encoding: "utf8", timeout: 30_000,
                });
                console.log(`MUTANT ${mutation.name} exit=${result.status}`);
                console.log(result.stdout.trim());
                assert.equal(result.status, 1, result.stdout + result.stderr);
                const failed = Number(/(\d+) failed/.exec(result.stdout)?.[1] ?? "0");
                assert(failed >= (mutation.minimumFailures ?? 1), "Missing expected Python red tests");
            } else {
                const { result, assertions, failures } = runNode(mutation.tests, mutation.pattern);
                console.log(`MUTANT ${mutation.name} exit=${result.status} red=${failures.length} selected=${assertions.filter((test) => test.status === "passed" || test.status === "failed").length}`);
                for (const failure of failures) {
                    console.log(`  RED ${failure.fullName}: ${failure.failureMessages[0]?.split("\n").slice(0, 2).join(" ")}`);
                }
                assert.equal(result.status, 1, result.stdout + result.stderr);
                assert(failures.length >= (mutation.minimumFailures ?? 1), "A runner error is not a killed mutant");
            }
            killed++;
        } finally {
            writeFileSync(sourcePath, before);
        }
    }
    for (const [path, before] of originals) {
        assert.deepEqual(readFileSync(join(root, path)), before, `Product tree changed: ${path}`);
    }
    console.log(`MUTATION_EVIDENCE ${killed}/${cases.length} killed; actual product files unchanged; exit=0`);
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
