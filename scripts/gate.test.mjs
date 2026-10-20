// Tests for the acceptance gate — run with: npm run gate:test
//
// Two layers. The pure-logic tests pin the skip/fail/pass decision and the exit code,
// which is where a silent false green would come from. The end-to-end tests build
// throwaway repositories in a temp directory and run the real gate against them, so the
// spawn path, the Windows shim avoidance, and the artifact detection are all exercised
// for real rather than asserted about.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
    LEGS,
    ROOT,
    STATUS,
    classify,
    commandFor,
    exitCodeFor,
    formatLine,
    formatSummary,
    resolveNodeBin,
    tally,
} from "./gate.mjs";

// --- pure decision logic -----------------------------------------------------

describe("classify", () => {
    const leg = { id: "lint", wp: "WP1", artifact: "eslint.config.js", kind: "node", pkg: "eslint" };

    test("skips when the artifact does not exist", () => {
        const decision = classify(leg, { artifactExists: false, tool: undefined });
        assert.equal(decision.action, "skip");
        assert.match(decision.note, /not yet implemented \(WP1/);
    });

    test("skips even when the tool happens to be installed", () => {
        // An installed tool must never resurrect a leg whose work package is unbuilt.
        const decision = classify(leg, { artifactExists: false, tool: { exe: "node", args: [] } });
        assert.equal(decision.action, "skip");
    });

    test("fails — never skips — when the artifact exists but the tool is missing", () => {
        const decision = classify(leg, { artifactExists: true, tool: undefined });
        assert.equal(decision.action, "fail");
        assert.match(decision.note, /setup required/);
        assert.match(decision.note, /npm run setup/);
    });

    test("names the python module when a python leg is unsatisfied", () => {
        const pyLeg = { id: "py-lint", wp: "WP1", artifact: "tools/report.py", kind: "python", module: "ruff" };
        const decision = classify(pyLeg, { artifactExists: true, tool: undefined });
        assert.match(decision.note, /python module "ruff"/);
    });

    test("runs when artifact and tool are both present", () => {
        const decision = classify(leg, { artifactExists: true, tool: { exe: "node", args: [] } });
        assert.equal(decision.action, "run");
    });
});

describe("exitCodeFor", () => {
    test("is 0 when every leg skipped", () => {
        assert.equal(exitCodeFor(LEGS.map((l) => ({ id: l.id, status: STATUS.SKIP }))), 0);
    });

    test("is 0 for a mix of passes and skips", () => {
        assert.equal(exitCodeFor([{ status: STATUS.PASS }, { status: STATUS.SKIP }]), 0);
    });

    test("is 1 when any leg failed", () => {
        assert.equal(exitCodeFor([{ status: STATUS.PASS }, { status: STATUS.FAIL }, { status: STATUS.SKIP }]), 1);
    });

    test("is 0 for no legs at all", () => {
        assert.equal(exitCodeFor([]), 0);
    });
});

describe("reporting", () => {
    test("tally counts each status", () => {
        const counts = tally([
            { status: STATUS.PASS }, { status: STATUS.PASS },
            { status: STATUS.FAIL }, { status: STATUS.SKIP },
        ]);
        assert.deepEqual(counts, { pass: 2, fail: 1, skip: 1, total: 4 });
    });

    test("summary reports passes against legs that actually ran, not against total", () => {
        const line = formatSummary([
            { status: STATUS.PASS }, { status: STATUS.PASS },
            { status: STATUS.SKIP }, { status: STATUS.SKIP },
        ]);
        assert.match(line, /2\/2 leg\(s\) passed, 2 skipped — PASSED/);
    });

    test("summary says FAILED when anything failed", () => {
        assert.match(formatSummary([{ status: STATUS.PASS }, { status: STATUS.FAIL }]), /1\/2 leg\(s\) passed — FAILED/);
    });

    test("a leg line carries id, status and note", () => {
        const line = formatLine({ id: "lint", status: STATUS.FAIL, seconds: 1.25, note: "boom" });
        assert.match(line, /^\[gate\] lint \.+ FAIL \(1\.3s\) — boom$/);
    });
});

describe("leg table", () => {
    test("every leg has a unique id", () => {
        assert.equal(new Set(LEGS.map((l) => l.id)).size, LEGS.length);
    });

    test("covers the seven legs the spec names, in order", () => {
        assert.deepEqual(
            LEGS.map((l) => l.id),
            ["lint", "typecheck", "test", "py-lint", "py-test", "workflows", "deploy"],
        );
    });

    test("every leg declares a known kind and an artifact", () => {
        for (const leg of LEGS) {
            assert.ok(["node", "python", "self"].includes(leg.kind), `${leg.id} has kind ${leg.kind}`);
            assert.equal(typeof leg.artifact, "string");
            assert.ok(leg.artifact.length > 0);
        }
    });

    test("commandFor rejects an unknown kind rather than silently passing the leg", () => {
        assert.throws(
            () => commandFor({ id: "x", kind: "wat" }, { root: ROOT, python: undefined, pythonModules: new Set() }),
            /unknown leg kind/,
        );
    });

    test("self legs run on this node binary, never on a shell shim", () => {
        const command = commandFor(LEGS.find((l) => l.kind === "self"), { root: ROOT });
        assert.equal(command.exe, process.execPath);
    });

    test("resolveNodeBin returns undefined for a package that is not installed", () => {
        assert.equal(resolveNodeBin("definitely-not-installed-xyz", undefined, ROOT), undefined);
    });

    test("typecheck and test key off the deliverable, not off their config files", () => {
        // tsc fails with no inputs and vitest fails with no test files, so keying these
        // legs off tsconfig.json / vitest.config.ts would force a throwaway fixture to
        // exist purely to keep the baseline green. They key off src/app.ts instead.
        for (const id of ["typecheck", "test"]) {
            assert.equal(LEGS.find((l) => l.id === id).artifact, "src/app.ts", `${id} artifact`);
        }
    });
});

// --- end to end --------------------------------------------------------------
// Each case builds a throwaway repo containing only scripts/gate.mjs plus whatever
// artifacts the case is about, then runs the real gate in a real child process.

const workspaces = [];
after(() => {
    for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "gate-e2e-"));
    workspaces.push(dir);
    mkdirSync(join(dir, "scripts"));
    cpSync(join(ROOT, "scripts", "gate.mjs"), join(dir, "scripts", "gate.mjs"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", type: "module" }));
    return dir;
}

function runGate(dir) {
    const proc = spawnSync(process.execPath, [join(dir, "scripts", "gate.mjs")], { encoding: "utf8" });
    return { code: proc.status, out: `${proc.stdout}${proc.stderr}` };
}

describe("end to end", () => {
    test("a bare repo skips every leg and exits 0", () => {
        const { code, out } = runGate(makeRepo());
        assert.equal(code, 0, out);
        assert.match(out, /0\/0 leg\(s\) passed, 7 skipped — PASSED/);
        for (const leg of LEGS) assert.match(out, new RegExp(`${leg.id} \\.+ SKIP`), `${leg.id} should skip`);
    });

    test("a passing self leg turns green and the gate still exits 0", () => {
        const dir = makeRepo();
        writeFileSync(join(dir, "scripts", "validate-workflows.mjs"), "process.exit(0);\n");
        const { code, out } = runGate(dir);
        assert.equal(code, 0, out);
        assert.match(out, /workflows \.+ PASS/);
        assert.match(out, /1\/1 leg\(s\) passed, 6 skipped — PASSED/);
    });

    test("a failing self leg fails the gate and surfaces its output", () => {
        const dir = makeRepo();
        writeFileSync(
            join(dir, "scripts", "validate-workflows.mjs"),
            'console.log("R2 violation at ci.yml:14"); process.exit(1);\n',
        );
        const { code, out } = runGate(dir);
        assert.equal(code, 1, out);
        assert.match(out, /workflows \.+ FAIL/);
        assert.match(out, /R2 violation at ci\.yml:14/, "failing leg output must reach the report");
        assert.match(out, /exit code 1/);
        assert.match(out, /— FAILED/);
    });

    test("an artifact with no installed tool fails with a remedy instead of skipping", () => {
        const dir = makeRepo();
        writeFileSync(join(dir, "eslint.config.js"), "export default [];\n");
        const { code, out } = runGate(dir);
        assert.equal(code, 1, out);
        assert.match(out, /lint \.+ FAIL/);
        assert.match(out, /setup required/);
        assert.match(out, /npm run setup/);
    });

    test("toolchain config alone does not wake the typecheck or test legs", () => {
        // The state this repository ships in before WP1: every config present, no source.
        // Both legs must skip rather than fail, or the baseline could not be green without
        // a throwaway fixture.
        const dir = makeRepo();
        writeFileSync(join(dir, "tsconfig.json"), "{}\n");
        writeFileSync(join(dir, "vitest.config.ts"), "export default {};\n");
        const { code, out } = runGate(dir);
        assert.equal(code, 0, out);
        assert.match(out, /typecheck \.+ SKIP/);
        assert.match(out, /test \.+ SKIP/);
    });

    test("one failing leg does not stop later legs from running", () => {
        const dir = makeRepo();
        writeFileSync(join(dir, "scripts", "validate-workflows.mjs"), "process.exit(1);\n");
        writeFileSync(join(dir, "scripts", "deploy.mjs"), "process.exit(0);\n");
        const { code, out } = runGate(dir);
        assert.equal(code, 1, out);
        assert.match(out, /workflows \.+ FAIL/);
        assert.match(out, /deploy \.+ PASS/, "the deploy leg must still run after workflows failed");
    });
});
