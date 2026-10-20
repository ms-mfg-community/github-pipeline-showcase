#!/usr/bin/env node
// The acceptance gate — SPEC.md §2. This file is the single definition of "it works".
//
// Every decision the gate makes is a pure function exported from here and unit-tested in
// gate.test.mjs. `main()` is the only part that touches the filesystem or spawns anything,
// so the skip/fail/pass logic can be exercised without a built repository.
//
// Three statuses, and the difference between them is the point:
//
//   SKIP — the leg's artifact does not exist yet. That work package has not been built.
//          Not a failure: it is what lets WP1 pass before WP2 and WP3 exist.
//   FAIL — the artifact exists but the leg did not pass, OR the tool it needs is not
//          installed. A missing tool is a real failure with a real remedy, never a skip,
//          because silently skipping it would report a green gate that proved nothing.
//   PASS — the leg ran and exited 0.
//
// Tools are invoked through their JavaScript entry points via `process.execPath` rather
// than through node_modules/.bin shims, and Python through `python -m`. Both avoid the
// Windows .cmd/.ps1 shim path, which Node refuses to spawn without a shell.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const STATUS = Object.freeze({ PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP" });

// --- leg table ---------------------------------------------------------------
//
// `artifact` is the file whose existence means this leg has something real to check. It
// is deliberately a source file the spec names as normative, never a generated one, so
// the gate cannot be fooled by a stale build directory.
//
// Choosing the artifact well is what keeps the baseline honest. `typecheck` and `test`
// key off src/app.ts — WP1's own central deliverable — because tsc fails outright with no
// inputs (TS18003) and vitest fails with no test files. Keying them off a config file
// would force a throwaway fixture to exist purely to keep them quiet. Keying them off the
// deliverable means the skip line names the work package that still owes the work.
//
// It also closes a hole: once src/app.ts exists, `test` is live, so shipping an
// application with no tests at all fails the gate rather than passing it silently.
//
// The gate calls each tool directly rather than through an npm script, so a work package
// cannot change what the gate measures by rewriting package.json.

export const LEGS = Object.freeze([
    { id: "lint", wp: "WP1", artifact: "eslint.config.js", kind: "node", pkg: "eslint", args: ["."] },
    { id: "typecheck", wp: "WP1", artifact: "src/app.ts", kind: "node", pkg: "typescript", bin: "tsc", args: ["--noEmit"] },
    { id: "test", wp: "WP1", artifact: "src/app.ts", kind: "node", pkg: "vitest", args: ["run"] },
    { id: "py-lint", wp: "WP1", artifact: "tools/report.py", kind: "python", module: "ruff", args: ["check", "tools"] },
    { id: "py-test", wp: "WP1", artifact: "tools/test_report.py", kind: "python", module: "pytest", args: ["tools", "-q"] },
    { id: "workflows", wp: "WP2", artifact: "scripts/validate-workflows.mjs", kind: "self", args: [] },
    { id: "deploy", wp: "WP3", artifact: "scripts/deploy.mjs", kind: "self", args: ["--self-test"] },
]);

// --- pure decision logic -----------------------------------------------------

/**
 * Decides what to do with a leg, given only facts about the environment. No I/O.
 *
 * @param {object} leg                    one entry from LEGS
 * @param {object} facts
 * @param {boolean} facts.artifactExists  does leg.artifact exist on disk
 * @param {object|undefined} facts.tool   resolved command, or undefined if unavailable
 * @returns {{action: "run"|"skip"|"fail", note: string}}
 */
export function classify(leg, facts) {
    if (!facts.artifactExists) {
        return { action: "skip", note: `not yet implemented (${leg.wp}: ${leg.artifact} absent)` };
    }
    if (!facts.tool) {
        const what = leg.kind === "python" ? `python module "${leg.module}"` : `"${leg.pkg ?? leg.id}"`;
        return { action: "fail", note: `setup required — ${what} is not installed; run: npm run setup` };
    }
    return { action: "run", note: "" };
}

/** Exit code for the whole gate: 1 if any leg failed, else 0. A skip is never a failure. */
export function exitCodeFor(results) {
    return results.some((r) => r.status === STATUS.FAIL) ? 1 : 0;
}

export function tally(results) {
    const count = (s) => results.filter((r) => r.status === s).length;
    return { pass: count(STATUS.PASS), fail: count(STATUS.FAIL), skip: count(STATUS.SKIP), total: results.length };
}

const DOT_WIDTH = 22;

export function formatLine({ id, status, seconds, note }) {
    const dots = ".".repeat(Math.max(1, DOT_WIDTH - id.length));
    const timing = typeof seconds === "number" ? ` (${seconds.toFixed(1)}s)` : "";
    return `[gate] ${id} ${dots} ${status}${timing}${note ? ` — ${note}` : ""}`;
}

export function formatSummary(results) {
    const { pass, fail, skip, total } = tally(results);
    const ran = total - skip;
    const verdict = fail > 0 ? "FAILED" : "PASSED";
    const skipped = skip > 0 ? `, ${skip} skipped` : "";
    return `[gate] ${pass}/${ran} leg(s) passed${skipped} — ${verdict}`;
}

// --- environment resolution (I/O) --------------------------------------------

/** Resolves a tool's real JS entry point from its own package manifest. */
export function resolveNodeBin(pkg, binName, root = ROOT) {
    const manifestPath = join(root, "node_modules", pkg, "package.json");
    if (!existsSync(manifestPath)) return undefined;
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
        return undefined;
    }
    const { bin } = manifest;
    const relative = typeof bin === "string" ? bin : bin?.[binName ?? pkg];
    if (typeof relative !== "string") return undefined;
    const entry = join(root, "node_modules", pkg, relative);
    return existsSync(entry) ? entry : undefined;
}

/** Prefers the project venv so the gate measures pinned tools, not whatever is on PATH. */
export function resolvePython(root = ROOT) {
    const venv = process.platform === "win32"
        ? join(root, ".venv", "Scripts", "python.exe")
        : join(root, ".venv", "bin", "python");
    if (existsSync(venv)) return venv;
    for (const candidate of ["python", "python3"]) {
        const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", shell: false });
        if (probe.status === 0) return candidate;
    }
    return undefined;
}

function pythonHasModule(python, moduleName) {
    if (!python) return false;
    return spawnSync(python, ["-c", `import ${moduleName}`], { stdio: "ignore" }).status === 0;
}

/** Builds the concrete command for a leg, or undefined when its tool is unavailable. */
export function commandFor(leg, env) {
    if (leg.kind === "node") {
        const entry = resolveNodeBin(leg.pkg, leg.bin, env.root);
        return entry ? { exe: process.execPath, args: [entry, ...leg.args] } : undefined;
    }
    if (leg.kind === "python") {
        if (!env.python || !env.pythonModules.has(leg.module)) return undefined;
        return { exe: env.python, args: ["-m", leg.module, ...leg.args] };
    }
    if (leg.kind === "self") {
        return { exe: process.execPath, args: [join(env.root, leg.artifact), ...leg.args] };
    }
    throw new Error(`gate: unknown leg kind ${JSON.stringify(leg.kind)}`);
}

// --- runner ------------------------------------------------------------------

function indent(text) {
    return String(text ?? "")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => `         ${line}`)
        .join("\n");
}

function runLeg(leg, env, log) {
    const artifactExists = existsSync(join(env.root, leg.artifact));
    const command = artifactExists ? commandFor(leg, env) : undefined;
    const { action, note } = classify(leg, { artifactExists, tool: command });

    if (action === "skip") {
        log(formatLine({ id: leg.id, status: STATUS.SKIP, note }));
        return { id: leg.id, status: STATUS.SKIP, note };
    }
    if (action === "fail") {
        log(formatLine({ id: leg.id, status: STATUS.FAIL, note }));
        return { id: leg.id, status: STATUS.FAIL, note };
    }

    const startedAt = Date.now();
    const proc = spawnSync(command.exe, command.args, { cwd: env.root, encoding: "utf8", shell: false });
    const seconds = (Date.now() - startedAt) / 1000;

    if (proc.error) {
        const failure = `could not start: ${proc.error.message}`;
        log(formatLine({ id: leg.id, status: STATUS.FAIL, seconds, note: failure }));
        return { id: leg.id, status: STATUS.FAIL, note: failure };
    }

    const status = proc.status === 0 ? STATUS.PASS : STATUS.FAIL;
    log(formatLine({ id: leg.id, status, seconds }));

    // Output is shown only on failure: a green gate should be quiet, and a red one must
    // carry enough for the next stage to act without re-running anything.
    if (status === STATUS.FAIL) {
        const body = [indent(proc.stdout), indent(proc.stderr)].filter(Boolean).join("\n");
        if (body) log(body);
        log(`         (exit code ${proc.status})`);
    }
    return { id: leg.id, status, note: "" };
}

export function main(argv = process.argv.slice(2), log = console.log) {
    const root = ROOT;

    if (argv.includes("--list")) {
        log(`[gate] ${LEGS.length} leg(s), in order:`);
        for (const leg of LEGS) {
            const present = existsSync(join(root, leg.artifact));
            log(`[gate]   ${leg.id.padEnd(12)} ${leg.wp}  artifact: ${leg.artifact}  ${present ? "(present)" : "(absent -> SKIP)"}`);
        }
        return 0;
    }

    const python = resolvePython(root);
    const pythonModules = new Set(
        ["ruff", "pytest"].filter((moduleName) => pythonHasModule(python, moduleName)),
    );
    const env = { root, python, pythonModules };

    log(`[gate] root: ${root}`);
    log(`[gate] node: ${process.version}  python: ${python ?? "(not found)"}`);
    log("");

    // Every leg runs even after one fails, so a single invocation reports the whole picture.
    const results = LEGS.map((leg) => runLeg(leg, env, log));

    log("");
    log(formatSummary(results));
    return exitCodeFor(results);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
