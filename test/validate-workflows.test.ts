import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// Regression tests for defects found in scripts/validate-workflows.mjs (SPEC.md §6.1, rules R1-R7).
//
// S1  Line numbers and the trailing comment R3 needs came from a hand-written indentation outline of the
//     text, so any spelling of YAML the outline did not model (flow style, escaped keys, aliases...) lost
//     its `uses:` line and was reported as having no version comment. Positions now come from the parser.
// S1b The parser does not report every entry as a key record and a value record: a one-entry mapping in a
//     flow sequence (`[uses: x]`) gets no record of its own, and an entry written without a value
//     (`{uses, name: x}`) has no record for it, so reading the records in twos lost the entry and R3 failed
//     closed on a valid spelling. And the comment after a quoted value that continues over a line break sits
//     on its closing line, which was never read. The entries are now rebuilt from the records, and a scalar's
//     end is a place to read a comment from.
// S2  Diagnostics were formatted with JSON.stringify, which throws on a recursive alias, and the command
//     line then reported that crash as a line-1 R1 "could not be read" in place of every real finding.
//
// Every "accepts" case has two negative twins (no comment; mutable tag), so a validator that simply
// stopped checking R2 and R3 could not pass them.
//
// The validator is a shebang-bearing script, which the test runner's own module loader cannot import, so
// it runs in a Node process, loaded the way the gate loads it. Every document-only check shares one such
// process (see `analyse`); the few that must hand the validator a parser of their own get one each.

type Violation = { line: number; rule: string; message: string };

const repository = fileURLToPath(new URL("../", import.meta.url));
const validatorPath = join(repository, "scripts", "validate-workflows.mjs");

/** Runs `body` in a fresh Node process that has the validator and js-yaml loaded. `input` arrives as `input`. */
function inNode<T>(body: string, input: unknown, timeout = 60_000): T {
    const program = `
        import { readFileSync } from "node:fs";
        import { createRequire } from "node:module";
        import * as validator from ${JSON.stringify(pathToFileURL(validatorPath).href)};
        const { load } = createRequire(import.meta.url)("js-yaml");
        const input = JSON.parse(readFileSync(0, "utf8"));
        const out = (value) => process.stdout.write(JSON.stringify(value));
        ${body}`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
        cwd: repository,
        input: JSON.stringify(input),
        encoding: "utf8",
        timeout,
        maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as T;
}

type Outcome = { findings: Violation[] } | { threw: string };
const documents: string[] = [];
let outcomes: Outcome[] = [];

/**
 * Registers `text` for the single batched run in `beforeAll`, and returns what that run found for it. A
 * document the validator throws on fails only the tests that read it, with the validator's own message.
 */
function analyse(text: string) {
    const index = documents.push(text) - 1;
    return (): Violation[] => {
        const outcome = outcomes[index];
        if (outcome === undefined) throw new Error("the batched validator run produced no result for this document");
        if ("threw" in outcome) throw new Error(`validateWorkflowText threw: ${outcome.threw}`);
        return outcome.findings;
    };
}

beforeAll(() => {
    outcomes = inNode<Outcome[]>(
        `out(input.map((text) => {
            try { return { findings: validator.validateWorkflowText(text) }; }
            catch (error) { return { threw: String(error) }; }
        }));`,
        documents,
    );
});

/** Each distinct finding as `rule:line`, in the validator's order. */
const distinct = (violations: Violation[]) => [...new Set(violations.map(({ rule, line }) => `${rule}:${line}`))];

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PIN = `actions/checkout@${SHA}`;

/** A workflow whose one job runs `steps`, which are written from line 8. */
const withSteps = (steps: string) =>
    ["name: Regression", "on: push", "permissions: {}", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:", steps, ""].join("\n");

/** A workflow whose one job has its steps written after the `steps:` key, on line 7. */
const withInlineSteps = (steps: string) =>
    ["name: Regression", "on: push", "permissions: {}", "jobs:", "  check:", "    runs-on: ubuntu-latest", `    steps: ${steps}`, ""].join("\n");

/** A workflow whose only job calls the reusable workflow `uses`, written on line 6. */
const withReusableJob = (uses: string) => ["name: Regression", "on: push", "permissions: {}", "jobs:", "  check:", `    uses: ${uses}`, ""].join("\n");

/** `pin` as a double-quoted scalar that continues on the next line: an escaped line break joins the halves. */
const continued = (pin: string, indent: string) => {
    const at = pin.indexOf("@") + 1;
    return `"${pin.slice(0, at)}\\\n${indent}${pin.slice(at)}"`;
};

/** One way of writing the same `uses:`, and the line that entry is written on, where findings must point. */
type Spelling = { name: string; line: number; build: (pin: string, note: string) => string };
const spellings: Spelling[] = [
    { name: "a flow-style step", line: 8, build: (pin, note) => withSteps(`      - {uses: '${pin}'}${note}`) },
    {
        name: "a multi-line flow step (the uses line, not the brace that opens the step)",
        line: 10,
        build: (pin, note) => withSteps(`      - {\n          name: Check out,\n          uses: ${pin},${note}\n          with: {fetch-depth: 0}\n        }`),
    },
    { name: "a value on the line after its key", line: 8, build: (pin, note) => withSteps(`      - uses:\n          ${pin}${note}`) },
    { name: "an escaped key", line: 8, build: (pin, note) => withSteps(`      - "u\\u0073es": ${pin}${note}`) },
    { name: "an explicit key", line: 8, build: (pin, note) => withSteps(`      - ? uses\n        : ${pin}${note}`) },
    { name: "a tagged value", line: 8, build: (pin, note) => withSteps(`      - uses: !!str ${pin}${note}`) },
    { name: "an anchored value", line: 8, build: (pin, note) => withSteps(`      - uses: &pinned ${pin}${note}`) },
    { name: "a block scalar", line: 8, build: (pin, note) => withSteps(`      - uses: >-${note}\n          ${pin}`) },
    {
        name: "a flow-style reusable job",
        line: 4,
        build: (pin, note) => `name: Regression\non: push\npermissions: {}\njobs: {check: {uses: '${pin}'}}${note}\n`,
    },
    {
        name: "an escaped job key",
        line: 8,
        build: (pin, note) => withSteps(`      - uses: ${pin}${note}`).replace("  check:", '  "ch\\u0065ck":'),
    },
    {
        name: "a step reused through an alias (written once, under the anchor)",
        line: 9,
        build: (pin, note) =>
            [
                "name: Regression",
                "on: push",
                "permissions: {}",
                "jobs:",
                "  first:",
                "    runs-on: ubuntu-latest",
                "    steps:",
                "      - &checkout",
                `        uses: ${pin}${note}`,
                "  second:",
                "    runs-on: ubuntu-latest",
                "    steps:",
                "      - *checkout",
                "",
            ].join("\n"),
    },
    {
        name: "a pin and its comment written once and reached through a scalar alias",
        line: 10,
        build: (pin, note) =>
            [
                "name: Regression",
                "on: push",
                "permissions: {}",
                "pins:",
                `  checkout: &checkout ${pin}${note}`,
                "jobs:",
                "  check:",
                "    runs-on: ubuntu-latest",
                "    steps:",
                "      - uses: *checkout",
                "",
            ].join("\n"),
    },
    {
        name: "an entry inherited through a merge key",
        line: 5,
        build: (pin, note) =>
            [
                "name: Regression",
                "on: push",
                "permissions: {}",
                "base: &base",
                `  uses: ${pin}${note}`,
                "jobs:",
                "  check:",
                "    runs-on: ubuntu-latest",
                "    steps:",
                "      - <<: *base",
                "",
            ].join("\n"),
    },
    // S1b: entries the parser composes without a record of their own, or without a record for the value.
    { name: "an unbraced flow pair", line: 7, build: (pin, note) => withInlineSteps(`[uses: '${pin}']${note}`) },
    { name: "an unbraced flow pair after another", line: 7, build: (pin, note) => withInlineSteps(`[name: Check out, uses: '${pin}']${note}`) },
    {
        name: "an unbraced flow pair on a line of its own (the uses line, not the bracket that opens the list)",
        line: 8,
        build: (pin, note) => withInlineSteps(`[\n      uses: '${pin}'${note}\n    ]`),
    },
    { name: "an explicit unbraced flow pair", line: 7, build: (pin, note) => withInlineSteps(`[? uses : '${pin}']${note}`) },
    { name: "a flow-style step with a key that has no value before it", line: 8, build: (pin, note) => withSteps(`      - {name, uses: ${pin}}${note}`) },
    { name: "a flow-style step with a key that has no value after it", line: 8, build: (pin, note) => withSteps(`      - {uses: ${pin}, name}${note}`) },
    { name: "an explicit key that has no value, before the entry", line: 9, build: (pin, note) => withSteps(`      - ? name\n        uses: ${pin}${note}`) },
    { name: "a key written as a flow sequence", line: 8, build: (pin, note) => withSteps(`      - [uses]: ${pin}${note}`) },
    {
        name: "a key reached through an alias",
        line: 9,
        build: (pin, note) =>
            ["name: Regression", "on: push", "permissions: {}", "keys: [&key uses]", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:", `      - *key : ${pin}${note}`, ""].join("\n"),
    },
    {
        name: "a merge key inside an unbraced flow pair",
        line: 5,
        build: (pin, note) =>
            ["name: Regression", "on: push", "permissions: {}", "base: &base", `  uses: ${pin}${note}`, "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps: [<<: *base]", ""].join("\n"),
    },
    // S1b: a double-quoted value can continue over a line break, and its comment follows the closing quote.
    {
        name: "a value continued over a line break (the comment is on the closing line)",
        line: 8,
        build: (pin, note) => withSteps(`      - uses: ${continued(pin, "          ")}${note}`),
    },
    {
        name: "a continued value on the line after its key",
        line: 8,
        build: (pin, note) => withSteps(`      - uses:\n          ${continued(pin, "          ")}${note}`),
    },
    { name: "a continued value in a flow-style step", line: 8, build: (pin, note) => withSteps(`      - {uses: ${continued(pin, "          ")}}${note}`) },
    { name: "a continued value in an unbraced flow pair", line: 7, build: (pin, note) => withInlineSteps(`[uses: ${continued(pin, "      ")}]${note}`) },
    {
        name: "a continued value of a reusable job",
        line: 6,
        build: (pin, note) => withReusableJob(`${continued(pin, "      ")}${note}`),
    },
    {
        name: "a continued value on the last line of a file with no final line break",
        line: 8,
        build: (pin, note) => withSteps(`      - uses: ${continued(pin, "          ")}${note}`).trimEnd(),
    },
    {
        name: "a continued value in a file with CRLF line ends",
        line: 8,
        build: (pin, note) => withSteps(`      - uses: ${continued(pin, "          ")}${note}`).replaceAll("\n", "\r\n"),
    },
    {
        name: "a continued value reached through a scalar alias (the comment is on the anchor's closing line)",
        line: 11,
        build: (pin, note) =>
            [
                "name: Regression",
                "on: push",
                "permissions: {}",
                "pins:",
                `  checkout: &checkout ${continued(pin, "    ")}${note}`,
                "jobs:",
                "  check:",
                "    runs-on: ubuntu-latest",
                "    steps:",
                "      - uses: *checkout",
                "",
            ].join("\n"),
    },
];

const rows = spellings.map((spelling) => ({
    ...spelling,
    accepted: analyse(spelling.build(PIN, " # v4.2.2")),
    uncommented: analyse(spelling.build(PIN, "")),
    mutable: analyse(spelling.build("actions/checkout@v4", " # v4")),
}));

const emptyUses = analyse(withSteps("      - uses:\n        name: Check out # v1.0.0"));
const commentsAround = analyse(withSteps(`      # v4.2.2\n      - uses: ${PIN}\n      # v4.2.2`));
const hashInQuotes = analyse(withSteps(`      - uses: "${PIN} # v4.2.2"`));
const bareKey = analyse(withSteps("      - {uses, name: Check out} # v1.0.0"));
const bareKeyUncommented = analyse(withSteps("      - {uses, name: Check out}"));
const bareExplicitKey = analyse(withInlineSteps("[? uses] # v1.0.0"));
const nullPair = analyse(withInlineSteps("[uses:] # v1.0.0"));
const nullPairUncommented = analyse(withInlineSteps("[uses:]"));
const flowJobsWithBareKey = analyse("name: x\non: push\npermissions: {}\njobs: {\n  a: {\n    runs-on: x,\n    environment,\n    permissions: write-all,\n  }\n}\n");

describe("S1: how a `uses:` is spelled does not change whether it passes", () => {
    it.each(rows)("accepts $name", ({ accepted }) => {
        expect(distinct(accepted())).toEqual([]);
    });

    it.each(rows)("reports R3 at the uses line for $name when there is no version comment", ({ uncommented, line }) => {
        expect(distinct(uncommented())).toEqual([`R3:${line}`]);
    });

    it.each(rows)("reports R2 at the uses line for $name when it is pinned to a mutable tag", ({ mutable, line }) => {
        expect(distinct(mutable())).toEqual([`R2:${line}`]);
    });

    it("does not lend an empty `uses:` the comment of the entry that follows it", () => {
        expect(distinct(emptyUses())).toEqual(["R2:8", "R3:8"]);
    });

    it("does not borrow a comment from the line above or below", () => {
        expect(distinct(commentsAround())).toEqual(["R3:9"]);
    });

    it("treats a # inside a quoted value as text, not as the version comment", () => {
        expect(distinct(hashInQuotes())).toEqual(["R2:8", "R3:8"]);
    });

    it("places an entry that sits beside a key with no value, instead of inventing an R3 for it", () => {
        // `{uses, name: x}` is composed as three records (uses, name, x), and `uses` has an empty value. It is not
        // a pair with `name`. Its own comment is the one after the brace, so only R2 (an empty value) is true.
        expect(distinct(bareKey())).toEqual(["R2:8"]);
        expect(distinct(bareKeyUncommented())).toEqual(["R2:8", "R3:8"]);
        expect(bareKeyUncommented().find(({ rule }) => rule === "R3")?.message).toContain("no trailing version comment");
    });

    it("places a flow entry with no value however it is written, instead of inventing an R3 for it", () => {
        expect(distinct(bareExplicitKey())).toEqual(["R2:7"]);
        expect(distinct(nullPair())).toEqual(["R2:7"]);
        expect(distinct(nullPairUncommented())).toEqual(["R2:7", "R3:7"]);
    });

    it("puts R5 and R7 on their own entry's line when a key beside it has no value", () => {
        // `environment,` has no value, and was composed as a lone key: counting records in twos paired the
        // entries after it with the wrong keys, so these two were reported on the line of the job instead.
        expect(distinct(flowJobsWithBareKey())).toEqual(["R7:7", "R5:8"]);
    });

    it("fails closed, and says why, when the parse gives no position for the entry", () => {
        // A parser that ignores its options reports no nodes, so the comment cannot be shown to exist.
        const text = withSteps(`      - uses: ${PIN} # v4.2.2`);
        const found = inNode<Violation[]>("out(validator.validateWorkflowText(input, (source) => load(source)));", text);
        expect(found.map(({ rule }) => rule)).toEqual(["R3"]);
        expect(found[0]?.message).toContain("could not be located");
    });

    it("does not trust a record that does not describe the value the parser stored", () => {
        // The parser here reports a different value for the pin than the one it returns. A position is only
        // used when it provably describes the thing the rules are checking, so the entry is not placed.
        const text = withSteps(`      - uses: ${PIN} # v4.2.2`);
        const found = inNode<Violation[]>(
            `const lying = (source, options) =>
                load(source, {
                    ...options,
                    listener: (event, state) =>
                        options.listener(event, event === "close" && state.result === ${JSON.stringify(PIN)} ? Object.assign(Object.create(state), { result: "another value" }) : state),
                });
            out(validator.validateWorkflowText(input, lying));`,
            text,
        );
        expect(found.map(({ rule }) => rule)).toEqual(["R3"]);
        expect(found[0]?.message).toContain("could not be located");
    });
});

// A comment is read from the end of a scalar as well as from its start. These are the places that must not
// make it read too far: a node the parser reports as ending on a LATER line (a block scalar, an alias) is not
// somewhere to read from, or this entry would be given the comment of whatever comes after it.
const nextStepCommented = "      - run: echo # v1.2.3";
const behindBlockScalar = analyse(withSteps(`      - uses: >-\n          ${PIN}\n${nextStepCommented}`));
const behindLiteralScalar = analyse(withSteps(`      - uses: |-\n          ${PIN}\n${nextStepCommented}`));
const behindAlias = analyse(
    [
        "name: Regression",
        "on: push",
        "permissions: {}",
        "pins:",
        `  checkout: &checkout ${PIN}`,
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: *checkout",
        nextStepCommented,
        "",
    ].join("\n"),
);
const behindContinued = analyse(withSteps(`      - uses: ${continued(PIN, "          ")}\n${nextStepCommented}`));
const hashInContinued = analyse(withSteps(`      - uses: ${continued(`${PIN} # v4.2.2`, "          ")}`));
const continuedNotAVersion = analyse(withSteps(`      - uses: ${continued(PIN, "          ")} # pinned`));
const repeatedBlockPin = analyse(withSteps(`      - uses: ${PIN}\n      - uses: ${PIN} # v4.2.2`));
const repeatedFlowPin = analyse(withInlineSteps(`[\n      uses: '${PIN}', # v4.2.2\n      uses: '${PIN}'\n    ]`));

describe("S1b: a comment is read from the lines an entry was written on, and no others", () => {
    it("does not give a block scalar the comment of the step after it", () => {
        expect(distinct(behindBlockScalar())).toEqual(["R3:8"]);
        expect(distinct(behindLiteralScalar())).toEqual(["R3:8"]);
    });

    it("does not give an alias the comment of the line after it", () => {
        expect(distinct(behindAlias())).toEqual(["R3:10"]);
    });

    it("does not give a continued value the comment of the step after its closing line", () => {
        expect(distinct(behindContinued())).toEqual(["R3:8"]);
    });

    it("treats a # inside a continued quoted value as text, not as the version comment", () => {
        expect(distinct(hashInContinued())).toEqual(["R2:8", "R3:8"]);
    });

    it("wants the comment on a continued value's closing line to name a version", () => {
        expect(distinct(continuedNotAVersion())).toEqual(["R3:8"]);
    });

    it("tells repeated pins apart by the line each was written on", () => {
        expect(distinct(repeatedBlockPin())).toEqual(["R3:8"]);
        expect(distinct(repeatedFlowPin())).toEqual(["R3:9"]);
    });
});

describe("S1b: what the validator relies on js-yaml to report", () => {
    // The parser's `listener` option is not documented, so the behaviour the recorder is built on is pinned
    // here. If a js-yaml upgrade changes it, this fails and names the change, rather than a later test
    // failing with a line number that is quietly wrong.
    const closes = (text: string) =>
        inNode<Array<[string | null, number, unknown]>>(
            `const closes = [];
            load(input, { listener(event, state) { if (event === "close") closes.push([state.kind, state.position, typeof state.result === "object" ? null : state.result]); } });
            out(closes);`,
            text,
        );

    it("composes a one-entry mapping in a flow sequence from two records and none of its own", () => {
        // "s: [uses: 'x@y']": the key `uses` ends at 8, the quoted value at 15 (just past its closing quote),
        // then the sequence. There is no mapping between them.
        expect(closes("s: [uses: 'x@y']\n")).toEqual([
            ["scalar", 1, "s"],
            ["scalar", 8, "uses"],
            ["scalar", 15, "x@y"],
            ["sequence", 16, null],
            ["mapping", 17, null],
        ]);
    });

    it("composes an entry without a value as a key and nothing else", () => {
        // A mapping can be reported twice, an outer node around the inner one that holds its contents, so
        // read up to the first mapping to complete. `uses` has no `:`, so it is followed by the next key.
        const found = closes("{uses, name: n}\n");
        const inner = found.slice(0, found.findIndex(([kind]) => kind === "mapping") + 1);
        expect(inner.map(([kind, , value]) => [kind, value])).toEqual([
            ["scalar", "uses"],
            ["scalar", "name"],
            ["scalar", "n"],
            ["mapping", null],
        ]);
    });

    it("ends a quoted scalar that continues over a line break just past its closing quote", () => {
        const text = 'a: "x\\\n  y" # c\n';
        const found = closes(text);
        expect(found[1]).toEqual(["scalar", text.indexOf('"', 6) + 1, "xy"]);
    });
});

describe("S1b: the command line agrees with the rules for every spelling", () => {
    const check = (directory: string) => spawnSync(process.execPath, [validatorPath, directory], { cwd: repository, encoding: "utf8", timeout: 30_000 });

    it("exits 0 for a workflow written each way, with the version comment", () => {
        inTemporaryDirectory((directory) => {
            spellings.forEach((spelling, i) => writeFileSync(join(directory, `spelling-${i}.yml`), spelling.build(PIN, " # v4.2.2")));
            const result = check(directory);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).not.toMatch(/: R\d /);
            expect(result.stdout).toContain(`${spellings.length} workflow file(s) checked, no violations`);
        });
    });

    it("exits 1 and names the file and the uses line for a workflow written each way, without it", () => {
        inTemporaryDirectory((directory) => {
            spellings.forEach((spelling, i) => writeFileSync(join(directory, `spelling-${i}.yml`), spelling.build(PIN, "")));
            const result = check(directory);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(1);
            const found = result.stdout
                .replaceAll("\\", "/")
                .split(/\r?\n/)
                .filter((row) => /: R\d /.test(row))
                .map((row) => /\/spelling-(\d+)\.yml:(\d+): (R\d) /.exec(row)?.slice(1).join(" "));
            // A step reused through an alias is one entry reported once per use, so compare what was found, not how often.
            expect([...new Set(found)].sort()).toEqual(spellings.map((spelling, i) => `${i} ${spelling.line} R3`).sort());
        });
    });
});

/** A workflow whose only job has `environment` (already indented) and whose workflow permissions are `permissions`. */
const withEnvironment = (environment: string, permissions = "{}") =>
    ["name: Regression", "on: push", `permissions: ${permissions}`, "jobs:", "  deploy:", "    runs-on: ubuntu-latest", environment, "    steps: []", ""].join("\n");

const RECURSIVE_ENVIRONMENT = "    environment: &env\n      name: *env";
const recursiveUses = analyse(withSteps("      - uses: &action {self: *action} # v4.2.2"));
const recursiveEnvironment = analyse(withEnvironment(RECURSIVE_ENVIRONMENT));
const unrenderableName = analyse("name: {toString: x}\non: push\npermissions: {}\n");

function inTemporaryDirectory(run: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), "validate-workflows-"));
    try {
        run(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe("S2: no value the parser can build makes the validator throw", () => {
    it("reports a recursive `uses:` as R2 at its line instead of throwing", () => {
        expect(distinct(recursiveUses())).toEqual(["R2:8"]);
        expect(recursiveUses()[0]?.message).toContain("[Circular]");
    });

    it("reports a recursive environment name as R7 at the name line instead of throwing", () => {
        expect(distinct(recursiveEnvironment())).toEqual(["R7:8"]);
        expect(recursiveEnvironment()[0]?.message).toContain("[Circular]");
    });

    it("does not throw on a `name:` that cannot be rendered as text, which is declared, not empty", () => {
        expect(distinct(unrenderableName())).toEqual([]);
    });

    it("does not write out an alias bomb in full", () => {
        // Each level points twice at the one before: 2^32 leaves if rendered whole.
        const levels = ["l0: &l0 [x, x]"];
        for (let i = 1; i <= 32; i++) levels.push(`l${i}: &l${i} [*l${i - 1}, *l${i - 1}]`);
        const text = ["name: Regression", "on: push", "permissions: {}", ...levels, "jobs:", "  check:", "    steps:", "      - uses: *l32", ""].join("\n");
        const line = text.split("\n").findIndex((row) => row.includes("uses:")) + 1;
        const found = inNode<Violation[]>("out(validator.validateWorkflowText(input));", text, 20_000);
        expect(distinct(found)).toEqual([`R2:${line}`, `R3:${line}`]);
    });

    it("keeps every other violation when one value is recursive, and never calls it a parse error", () => {
        inTemporaryDirectory((directory) => {
            writeFileSync(join(directory, "recursive.yml"), withEnvironment(RECURSIVE_ENVIRONMENT, "write-all"));
            const result = spawnSync(process.execPath, [validatorPath, directory], { cwd: repository, encoding: "utf8", timeout: 30_000 });
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(1);
            const findings = result.stdout
                .replaceAll("\\", "/")
                .split(/\r?\n/)
                .filter((row) => /: R\d /.test(row))
                .map((row) => row.replace(/^.*\/recursive\.yml:/, "").slice(0, 5));
            expect(findings).toEqual(["3: R5", "8: R7"]);
        });
    });
});

describe("S2: only the parser's verdict is an R1", () => {
    it("reports a file the parser rejects as R1, at the line the parser names", () => {
        const text = `${withSteps(`      - uses: ${PIN} # v4.2.2`)}broken: [\n`;
        const found = inNode<Violation[]>("out(validator.validateWorkflowText(input));", text);
        expect(found).toMatchObject([{ rule: "R1", line: 10 }]);
    });

    it("takes a YAMLException from any parser as R1", () => {
        const found = inNode<Violation[]>(
            `const rejecting = () => { throw Object.assign(new Error("formatted"), { name: "YAMLException", reason: "bad indentation", mark: { line: 6 } }); };
            out(validator.validateWorkflowText(input, rejecting));`,
            "name: x\n",
        );
        expect(found).toEqual([{ line: 7, rule: "R1", message: "is not valid YAML: bad indentation" }]);
    });

    it("does not blame the workflow for a fault of its own", () => {
        // A TypeError from the parser's side is a bug in the validator, never a finding about the file.
        inTemporaryDirectory((directory) => {
            writeFileSync(join(directory, "fine.yml"), withSteps(`      - uses: ${PIN} # v4.2.2`));
            const outcome = inNode<{ text: string; directory: string }>(
                `const faulty = () => { throw new TypeError("a bug in the validator"); };
                const attempt = (run) => { try { run(); return "returned"; } catch (error) { return String(error); } };
                out({
                    text: attempt(() => validator.validateWorkflowText("name: x\\n", faulty)),
                    directory: attempt(() => validator.validateDirectory(input, faulty)),
                });`,
                directory,
            );
            expect(outcome).toEqual({
                text: "TypeError: a bug in the validator",
                directory: "TypeError: a bug in the validator",
            });
        });
    });
});
