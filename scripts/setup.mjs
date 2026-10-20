#!/usr/bin/env node
// Installs everything the gate needs — SPEC.md §2.1. Idempotent: safe to re-run.
//
// Node dependencies go through npm. Python dependencies go into a project-local .venv
// rather than the machine's Python, so the gate measures pinned tool versions and a demo
// repository never mutates the host interpreter.
//
// Both halves are skipped cleanly when their manifest does not exist yet, so `npm run
// setup` works on the bare skeleton as well as on the finished repository.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENV = join(ROOT, ".venv");
const VENV_PYTHON = process.platform === "win32"
    ? join(VENV, "Scripts", "python.exe")
    : join(VENV, "bin", "python");

const log = (message) => console.log(`[setup] ${message}`);

function run(exe, args, { shell = false } = {}) {
    const proc = spawnSync(exe, args, { cwd: ROOT, stdio: "inherit", shell });
    if (proc.error) return { ok: false, reason: proc.error.message };
    return proc.status === 0 ? { ok: true } : { ok: false, reason: `exit code ${proc.status}` };
}

function hostPython() {
    for (const candidate of ["python", "python3"]) {
        if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
    }
    return undefined;
}

function hasNodeDependencies() {
    try {
        const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
        return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length > 0;
    } catch {
        return false;
    }
}

function setupNode() {
    if (!existsSync(join(ROOT, "package.json"))) {
        log("node: no package.json — skipped");
        return true;
    }
    if (!hasNodeDependencies()) {
        log("node: package.json declares no dependencies yet — skipped");
        return true;
    }
    // npm is a .cmd shim on Windows, which Node will not spawn without a shell. The
    // arguments here are fixed literals, so there is nothing for a shell to interpolate.
    log("node: installing dependencies…");
    const result = run("npm", ["install", "--no-fund", "--no-audit"], { shell: process.platform === "win32" });
    if (!result.ok) log(`node: FAILED (${result.reason})`);
    return result.ok;
}

function setupPython() {
    const requirements = join(ROOT, "tools", "requirements-dev.txt");
    if (!existsSync(requirements)) {
        log("python: tools/requirements-dev.txt absent — skipped");
        return true;
    }
    if (!existsSync(VENV_PYTHON)) {
        const python = hostPython();
        if (!python) {
            log("python: FAILED — no python interpreter found on PATH");
            return false;
        }
        log(`python: creating .venv with ${python}…`);
        const created = run(python, ["-m", "venv", VENV]);
        if (!created.ok) {
            log(`python: FAILED to create .venv (${created.reason})`);
            return false;
        }
    } else {
        log("python: reusing existing .venv");
    }

    log("python: installing dev dependencies…");
    const upgraded = run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
    if (!upgraded.ok) log(`python: pip self-upgrade skipped (${upgraded.reason})`);

    const installed = run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "-r", requirements]);
    if (!installed.ok) log(`python: FAILED (${installed.reason})`);
    return installed.ok;
}

function main() {
    log(`root: ${ROOT}`);
    const nodeOk = setupNode();
    const pythonOk = setupPython();

    if (nodeOk && pythonOk) {
        log("done — now run: npm run gate");
        return 0;
    }
    log("one or more setup steps failed; see the output above");
    return 1;
}

process.exit(main());
