import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// SPEC.md §6.1: the same parsed entry must get the same R1-R7 decisions regardless
// of YAML spelling. These combinations exercise the round-3 pair reconstruction,
// key normalization and scalar-closing-line fix, including their sibling callers.
const repository = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = process.env.WP2_QA_ARTIFACT_ROOT ?? repository;
const validatorPath = join(artifactRoot, "scripts/validate-workflows.mjs");
const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };
const PIN = "actions/checkout@0123456789abcdef0123456789abcdef01234567";
const top = "name: Round-three QA\non: push\npermissions: {}\n";
const job = "jobs:\n  check:\n    steps:";
type Violation = { line: number; rule: string; message: string };
type Outcome = { violations: Violation[] } | { threw: string };
const documents: string[] = [];
let outcomes: Outcome[] = [];

function analyse(text: string) {
    const index = documents.push(text) - 1;
    return () => {
        const outcome = outcomes[index];
        expect(outcome, `No result for fixture ${index}`).toHaveProperty("violations");
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

type Spelling = { label: string; line: number; build: (pin: string, note: string) => string };
const spellings: Spelling[] = [
    {
        label: "an aliased key in an unbraced pair",
        line: 7,
        build: (pin, note) => `${top}keys: [&key uses]\n${job} [*key : '${pin}']${note}\n`,
    },
    {
        label: "a sequence key in an unbraced pair",
        line: 6,
        build: (pin, note) => `${top}${job} [[uses]: '${pin}']${note}\n`,
    },
    {
        label: "an unbraced pair among ordinary entries and other pairs",
        line: 6,
        build: (pin, note) => `${top}${job} [null, {run: echo}, name: null, uses: '${pin}', {run: done}]${note}\n`,
    },
    {
        label: "an explicit pair with the colon on the next line",
        line: 7,
        build: (pin, note) => `${top}${job} [\n      ? uses\n      : '${pin}'${note}\n    ]\n`,
    },
    {
        label: "a flow mapping following two entries without values",
        line: 7,
        build: (pin, note) => `${top}${job}\n      - {name, id, uses: '${pin}'}${note}\n`,
    },
    {
        label: "a continued quoted value following its anchor on a separate line",
        line: 7,
        build: (pin, note) => {
            const split = pin.indexOf("@") + 1;
            return `${top}${job}\n      - uses: &pin\n          "${pin.slice(0, split)}\\\n          ${pin.slice(split)}"${note}\n`;
        },
    },
    {
        label: "an unbraced pair with the value on the next line",
        line: 6,
        build: (pin, note) => `${top}${job} [uses:\n      '${pin}'${note}\n    ]\n`,
    },
];
const rows = spellings.map((spelling) => ({
    ...spelling,
    text: spelling.build(PIN, " # v4.2.2"),
    clean: analyse(spelling.build(PIN, " # v4.2.2")),
    uncommented: analyse(spelling.build(PIN, "")),
    mutable: analyse(spelling.build("actions/checkout@v4", " # v4.2.2")),
}));

describe("round-3 pair and scalar-end combinations", () => {
    it.each(rows)("accepts $label with its own version comment", ({ text, clean }) => {
        const parsed = load(text) as { jobs: { check: { steps: Array<Record<string, unknown> | null> } } };
        const actions = parsed.jobs.check.steps.filter((step) => step !== null && Object.hasOwn(step, "uses"));
        expect(actions.map((step) => step?.uses)).toEqual([PIN]);
        expect(clean()).toEqual([]);
    });

    it.each(rows)("requires R3 on the original key line for $label", ({ uncommented, line }) => {
        expect(uncommented()).toEqual([{ rule: "R3", line }]);
    });

    it.each(rows)("requires only R2 for a commented mutable pin in $label", ({ mutable, line }) => {
        expect(mutable()).toEqual([{ rule: "R2", line }]);
    });
});

const siblingCases = [
    {
        label: "flow-sequence semantic keys",
        text: "name: QA\non: push\n[permissions]: write-all\njobs:\n  check:\n    [permissions]: write-all\n    environment:\n      [name]: staging\n    steps: []\n",
        expected: [{ rule: "R5", line: 3 }, { rule: "R5", line: 6 }, { rule: "R7", line: 8 }],
    },
    {
        label: "aliased semantic keys",
        text: "keys: [&perms permissions, &env environment, &name name]\n*name : QA\non: push\n*perms : write-all\njobs:\n  check:\n    *perms : write-all\n    *env :\n      *name : staging\n    steps: []\n",
        expected: [{ rule: "R5", line: 4 }, { rule: "R5", line: 7 }, { rule: "R7", line: 9 }],
    },
    {
        label: "multiple bare flow keys beside a trigger and permissions",
        text: "{\n  name: QA,\n  spare,\n  on: {},\n  unused,\n  permissions: write-all,\n  jobs: {\n    check: {\n      spare,\n      unused,\n      permissions: write-all,\n      environment: {spare, unused, name: staging},\n      steps: []\n    }\n  }\n}\n",
        expected: [{ rule: "R6", line: 4 }, { rule: "R5", line: 6 }, { rule: "R5", line: 11 }, { rule: "R7", line: 12 }],
    },
].map((row) => ({ ...row, actual: analyse(row.text) }));

describe("round-3 entry lookup sibling callers", () => {
    it.each(siblingCases)("keeps every diagnostic on its own line with $label", ({ text, actual, expected }) => {
        const parsed = load(text) as { permissions: string; jobs: { check: { permissions: string; environment: { name: string } } } };
        expect(parsed.permissions).toBe("write-all");
        expect(parsed.jobs.check.permissions).toBe("write-all");
        expect(parsed.jobs.check.environment.name).toBe("staging");
        expect(actual()).toEqual(expected);
    });
});

function inDirectory(run: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), "wp2-round3-qa-"));
    try {
        run(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

function cli(directory: string) {
    return spawnSync(process.execPath, [validatorPath, directory], {
        cwd: repository, encoding: "utf8", timeout: 20_000,
    });
}

describe("round-3 CLI integration", () => {
    it("returns 0 for the real files written in each new combination", () => {
        inDirectory((directory) => {
            rows.forEach((row, index) => writeFileSync(join(directory, `${index}.yml`), row.text));
            const result = cli(directory);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).not.toMatch(/: R[1-7] /);
            expect(result.stdout).toContain(`${rows.length} workflow file(s) checked, no violations`);
        });
    });

    it("returns 1 with every original uses line after removing those comments", () => {
        inDirectory((directory) => {
            rows.forEach((row, index) => writeFileSync(join(directory, `${index}.yml`), row.build(PIN, "")));
            const result = cli(directory);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(1);
            const found = result.stdout.replaceAll("\\", "/").split(/\r?\n/)
                .filter((line) => /: R[1-7] /.test(line))
                .map((line) => /\/(\d+)\.yml:(\d+): (R[1-7]) /.exec(line)?.slice(1));
            expect(found).toEqual(rows.map((row, index) => [String(index), String(row.line), "R3"]));
            expect(result.stderr).toBe("");
        });
    });
});
