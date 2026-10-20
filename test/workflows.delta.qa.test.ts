import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// Round-2 QA: the R1-R7 contract in SPEC.md §6.1 is independent of YAML spelling.
// Parse the positive fixtures independently, then check the validator and its CLI.
const repository = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = process.env.WP2_QA_ARTIFACT_ROOT ?? repository;
const validatorPath = join(artifactRoot, "scripts/validate-workflows.mjs");
const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };
const PIN = "actions/checkout@0123456789abcdef0123456789abcdef01234567";
const prefix = "name: Delta QA\non: push\npermissions: {}\njobs:\n  check:\n    runs-on: ubuntu-latest\n";
const withSteps = (steps: string) => `${prefix}    steps:\n${steps}\n`;
const ordinary = withSteps(`      - uses: ${PIN} # v4.2.2`);
type Violation = { line: number; rule: string; message: string };
type Outcome = { violations: Violation[] } | { threw: string };
const documents: string[] = [];
let outcomes: Outcome[] = [];

function analyse(text: string) {
    const index = documents.push(text) - 1;
    return () => {
        const outcome = outcomes[index];
        expect(outcome, `No diagnostic result for fixture ${index}`).toHaveProperty("violations");
        if (outcome === undefined || "threw" in outcome) return [];
        return outcome.violations.map(({ line, rule }) => ({ line, rule }));
    };
}

beforeAll(() => {
    const program = `
        import { readFileSync } from "node:fs";
        import { validateWorkflowText } from ${JSON.stringify(pathToFileURL(validatorPath).href)};
        const texts = JSON.parse(readFileSync(0, "utf8"));
        process.stdout.write(JSON.stringify(texts.map((text) => {
            try { return { violations: validateWorkflowText(text) }; }
            catch (error) { return { threw: String(error) }; }
        })));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
        cwd: repository, input: JSON.stringify(documents), encoding: "utf8",
        timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    outcomes = JSON.parse(result.stdout) as Outcome[];
}, 30_000);

function continued(pin: string, indent: string) {
    const split = pin.indexOf("@") + 1;
    return `"${pin.slice(0, split)}\\\n${indent}${pin.slice(split)}"`;
}

const spellings = [
    {
        label: "an unbraced flow pair",
        line: 7,
        build: (pin: string, comment: string) => `${prefix}    steps: [uses: '${pin}']${comment}\n`,
    },
    {
        label: "a multiline unbraced flow pair",
        line: 8,
        build: (pin: string, comment: string) => `${prefix}    steps: [\n      uses: '${pin}'${comment}\n    ]\n`,
    },
    {
        label: "a continued quoted scalar with its comment on the closing line",
        line: 8,
        build: (pin: string, comment: string) => withSteps(`      - uses: ${continued(pin, "          ")}${comment}`),
    },
    {
        label: "an alias of a continued quoted scalar",
        line: 11,
        build: (pin: string, comment: string) =>
            `name: Delta QA\non: push\npermissions: {}\npins:\n  checkout: &checkout ${continued(pin, "    ")}${comment}\n` +
            "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: *checkout\n",
    },
];
const rows = spellings.map((spelling) => ({
    ...spelling,
    text: spelling.build(PIN, " # v4.2.2"),
    clean: analyse(spelling.build(PIN, " # v4.2.2")),
    missingComment: analyse(spelling.build(PIN, "")),
    mutable: analyse(spelling.build("actions/checkout@v4", " # v4.2.2")),
}));
const emptyFlowEntry = analyse(withSteps("      - {uses, name: Check out} # v4.2.2"));

describe("round-2 YAML source-position delta", () => {
    it.each(rows)("accepts $label without adding a YAML-format rule", ({ text, clean }) => {
        const parsed = load(text) as { jobs: { check: { steps: Array<{ uses: string }> } } };
        expect(parsed.jobs.check.steps[0]?.uses).toBe(PIN);
        expect(clean()).toEqual([]);
    });

    it.each(rows)("reports missing comments at the uses line for $label", ({ missingComment, line }) => {
        expect(missingComment()).toEqual([{ rule: "R3", line }]);
    });

    it.each(rows)("reports only R2 for a commented mutable pin in $label", ({ mutable, line }) => {
        expect(mutable()).toEqual([{ rule: "R2", line }]);
    });

    it("does not invent R3 when an empty flow entry has its own trailing version comment", () => {
        expect(emptyFlowEntry()).toEqual([{ rule: "R2", line: 8 }]);
    });
});

const recursiveUsesText = withSteps("      - uses: &action [*action] # v4.2.2")
    .replace("permissions: {}", "permissions: write-all");
const recursiveEnvironmentText = ordinary
    .replace("permissions: {}", "permissions: write-all")
    .replace("    runs-on:", "    environment:\n      name: &environment [*environment]\n    runs-on:");
const recursiveUses = analyse(recursiveUsesText);
const recursiveEnvironment = analyse(recursiveEnvironmentText);
const repeatFirst = analyse(recursiveUsesText);
const repeatClean = analyse(ordinary);
const repeatLast = analyse(recursiveUsesText);

describe("round-2 diagnostic formatting delta", () => {
    it("reports recursive array uses without discarding independent R5", () => {
        expect(recursiveUses()).toEqual([{ rule: "R5", line: 3 }, { rule: "R2", line: 8 }]);
    });

    it("reports recursive array environment names without discarding independent R5", () => {
        expect(recursiveEnvironment()).toEqual([{ rule: "R5", line: 3 }, { rule: "R7", line: 7 }]);
    });

    it("does not leak parser or formatter state between recursive and clean documents", () => {
        expect(repeatFirst()).toEqual([{ rule: "R5", line: 3 }, { rule: "R2", line: 8 }]);
        expect(repeatClean()).toEqual([]);
        expect(repeatLast()).toEqual(repeatFirst());
    });
});

function withDirectory(run: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), "wp2-delta-qa-"));
    try {
        run(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

function cli(directory: string) {
    return spawnSync(process.execPath, [validatorPath, directory], {
        cwd: repository, encoding: "utf8", timeout: 15_000,
    });
}

describe("round-2 command-line delta", () => {
    it("returns 0 for a clean workflow whose steps use unbraced flow pairs", () => {
        withDirectory((directory) => {
            writeFileSync(join(directory, "clean.yml"), spellings[1]!.build(PIN, " # v4.2.2"));
            const result = cli(directory);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).not.toMatch(/: R[1-7] /);
        });
    });

    it("returns 1 and preserves every real diagnostic across recursive array values", () => {
        withDirectory((directory) => {
            const text = recursiveUsesText.replace(
                "    runs-on:",
                "    environment:\n      name: &environment [*environment]\n    runs-on:",
            );
            writeFileSync(join(directory, "recursive-arrays.yml"), text);
            const result = cli(directory);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(1);
            const findings = result.stdout.replaceAll("\\", "/").split(/\r?\n/).filter((line) => /: R[1-7] /.test(line));
            expect(findings).toHaveLength(3);
            expect(findings[0]).toContain("/recursive-arrays.yml:3: R5 ");
            expect(findings[1]).toContain("/recursive-arrays.yml:7: R7 ");
            expect(findings[2]).toContain("/recursive-arrays.yml:10: R2 ");
            expect(result.stdout + result.stderr).not.toContain(": R1 ");
            expect(result.stderr).toBe("");
        });
    });
});
