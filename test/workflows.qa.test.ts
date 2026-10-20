import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Fixtures below come from SPEC.md §6.1, not from the validator's implementation.
// Real configuration tests read the deliverables rather than copies of them.
const repository = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = process.env.WP2_QA_ARTIFACT_ROOT ?? repository;
const validatorPath = join(artifactRoot, "scripts/validate-workflows.mjs");
type Violation = { line: number; rule: string; message: string };
// Execute the module with Node's loader, not Vite's VM loader: the delivered file is
// a shebang-bearing CLI with a top-level asynchronous parser import.
const validator = {
    validateWorkflowText(text: string): Violation[] {
        const program = `import { readFileSync } from "node:fs";
            import { validateWorkflowText } from ${JSON.stringify(pathToFileURL(validatorPath).href)};
            process.stdout.write(JSON.stringify(validateWorkflowText(readFileSync(0, "utf8"))));`;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
            input: text, cwd: repository, encoding: "utf8", timeout: 15_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        return JSON.parse(result.stdout) as Violation[];
    },
};
const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = [
    "name: QA workflow",
    "on: push",
    "permissions: { contents: read }",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: actions/checkout@${SHA} # v4.2.2`,
    "",
].join("\n");
const rules = (text: string) => validator.validateWorkflowText(text).map(({ line, rule }) => ({ line, rule }));

describe("WP2 validator: R1-R7 and no additional rules", () => {
    it.each([
        ["ordinary block YAML", BASE],
        ["BOM and CRLF", `\uFEFF${BASE.replaceAll("\n", "\r\n")}`],
        ["local action without a pin or comment", BASE.replace(`actions/checkout@${SHA} # v4.2.2`, "./actions/example")],
        ["empty least-privilege permissions", BASE.replace("{ contents: read }", "{}")],
        ["read-all permissions", BASE.replace("{ contents: read }", "read-all")],
        ["sequence triggers", BASE.replace("on: push", "on: [push, pull_request]")],
        ["mapping triggers", BASE.replace("on: push", "on:\n  pull_request:")],
        ["no event-name allowlist", BASE.replace("on: push", "on: future_event")],
        ["quoted uses key and value", BASE.replace(`uses: actions/checkout@${SHA}`, `"uses": 'actions/checkout@${SHA}'`)],
        ["nested action path", BASE.replace("actions/checkout@", "owner/repository/sub/directory@")],
        ["upper-case hexadecimal SHA", BASE.replace(SHA, SHA.toUpperCase())],
        ["block scalar action value", BASE.replace(`uses: actions/checkout@${SHA} # v4.2.2`, `uses: >- # v4.2.2\n          actions/checkout@${SHA}`)],
        ["local reusable workflow", BASE.replace(`    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA} # v4.2.2`, "    uses: ./.github/workflows/reusable.yml")],
        ["pinned reusable workflow", BASE.replace(`    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA} # v4.2.2`, `    uses: owner/repo/.github/workflows/reusable.yml@${SHA} # v1.0.0`)],
        ["rule-looking shell text is not configuration", `${BASE}      - run: |\n          uses: unpinned\n          permissions: write-all\n          environment: staging\n`],
    ])("accepts %s", (_label, text) => {
        expect(rules(text)).toEqual([]);
    });

    it.each([
        ["flow-style step", BASE.replace(`- uses: actions/checkout@${SHA} # v4.2.2`, `- {uses: 'actions/checkout@${SHA}'} # v4.2.2`)],
        ["flow-style reusable job", `name: QA workflow\non: push\npermissions: {}\njobs: {check: {uses: 'owner/repo/.github/workflows/reusable.yml@${SHA}'}} # v1.0.0\n`],
        ["escaped quoted job key", BASE.replace("  check:", '  "ch\\u0065ck":')],
        ["aliased pinned step", `name: QA workflow\non: push\npermissions: {}\njobs:\n  first:\n    runs-on: ubuntu-latest\n    steps:\n      - &checkout\n        uses: actions/checkout@${SHA} # v4.2.2\n  second:\n    runs-on: ubuntu-latest\n    steps:\n      - *checkout\n`],
    ])("accepts valid YAML spelling: %s", (_label, text) => {
        expect(rules(text)).toEqual([]);
    });

    it("R1 reports malformed YAML, not a misleading set of downstream violations", () => {
        const found = validator.validateWorkflowText(`${BASE}broken: [\n`);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ rule: "R1", line: 10 });
    });

    it.each([
        ["mutable tag", "actions/checkout@v4"],
        ["39 hex characters", `owner/repo@${SHA.slice(1)}`],
        ["41 hex characters", `owner/repo@${SHA}0`],
        ["non-hex SHA", `owner/repo@${"g".repeat(40)}`],
        ["missing repository owner", `checkout@${SHA}`],
        ["unpinned action", "actions/checkout"],
        ["Docker action outside the R2 pattern", "docker://alpine:3"],
    ])("R2 rejects %s", (_label, value) => {
        expect(rules(BASE.replace(`actions/checkout@${SHA}`, value))).toEqual([{ rule: "R2", line: 8 }]);
    });

    it("R2 also inspects job-level reusable workflows", () => {
        const text = BASE.replace(`    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA} # v4.2.2`, "    uses: owner/repo/.github/workflows/reuse.yml@v1 # v1.0.0");
        expect(rules(text)).toEqual([{ rule: "R2", line: 6 }]);
    });

    it.each(["null", "123", "[]", "{}"])("R2 rejects the non-string uses value %s", (value) => {
        expect(rules(BASE.replace(`actions/checkout@${SHA}`, value))).toEqual([{ rule: "R2", line: 8 }]);
    });

    it("R2 reports a recursive mapping value without crashing or inventing an R1 parse error", () => {
        expect(rules(BASE.replace(`actions/checkout@${SHA}`, "&action {self: *action}"))).toEqual([{ rule: "R2", line: 8 }]);
    });

    it.each([
        ["absent", ""],
        ["non-version comment", "# pinned"],
        ["latest is not a version", "# latest"],
    ])("R3 rejects an %s version comment", (_label, comment) => {
        expect(rules(BASE.replace("# v4.2.2", comment))).toEqual([{ rule: "R3", line: 8 }]);
    });

    it("R3 does not borrow a version comment from the preceding line", () => {
        const text = BASE.replace(`      - uses: actions/checkout@${SHA} # v4.2.2`, `      # v4.2.2\n      - uses: actions/checkout@${SHA}`);
        expect(rules(text)).toEqual([{ rule: "R3", line: 9 }]);
    });

    it("R4 rejects missing workflow permissions even when a job has them", () => {
        const text = BASE.replace("permissions: { contents: read }\n", "").replace("    runs-on:", "    permissions: {}\n    runs-on:");
        expect(rules(text)).toEqual([{ rule: "R4", line: 1 }]);
    });

    it("R4 rejects an empty permissions value", () => {
        expect(rules(BASE.replace("{ contents: read }", ""))).toEqual([{ rule: "R4", line: 3 }]);
    });

    it("R5 rejects workflow write-all", () => {
        expect(rules(BASE.replace("{ contents: read }", "write-all"))).toEqual([{ rule: "R5", line: 3 }]);
    });

    it("R5 rejects job write-all even when the workflow is read-only", () => {
        expect(rules(BASE.replace("    runs-on:", "    permissions: write-all\n    runs-on:"))).toEqual([{ rule: "R5", line: 6 }]);
    });

    it.each([
        ["missing name", BASE.replace("name: QA workflow\n", ""), 1],
        ["empty name", BASE.replace("name: QA workflow", 'name: ""'), 1],
        ["missing trigger", BASE.replace("on: push\n", ""), 1],
        ["empty trigger sequence", BASE.replace("on: push", "on: []"), 2],
        ["empty trigger mapping", BASE.replace("on: push", "on: {}"), 2],
        ["null trigger", BASE.replace("on: push", "on:"), 2],
    ])("R6 rejects %s", (_label, text, line) => {
        expect(rules(String(text))).toEqual([{ rule: "R6", line }]);
    });

    it.each(["dev", "test", "prod"])("R7 accepts scalar and mapping environment %s", (environment) => {
        expect(rules(BASE.replace("    runs-on:", `    environment: ${environment}\n    runs-on:`))).toEqual([]);
        expect(rules(BASE.replace("    runs-on:", `    environment:\n      name: ${environment}\n      url: https://example.com\n    runs-on:`))).toEqual([]);
    });

    it.each(["staging", "Dev", "null", "{}", "'${{ inputs.environment }}'"])("R7 rejects environment %s", (environment) => {
        expect(rules(BASE.replace("    runs-on:", `    environment: ${environment}\n    runs-on:`))).toEqual([{ rule: "R7", line: 6 }]);
    });

    it("R7 locates an invalid mapping environment name", () => {
        expect(rules(BASE.replace("    runs-on:", "    environment:\n      name: staging\n    runs-on:"))).toEqual([{ rule: "R7", line: 7 }]);
    });

    it("R7 reports a recursive mapping name without crashing or inventing an R1 parse error", () => {
        expect(rules(BASE.replace("    runs-on:", "    environment: &environment\n      name: *environment\n    runs-on:"))).toEqual([{ rule: "R7", line: 7 }]);
    });

    it.each(["", "# comments only\n", "a scalar document\n"])("handles empty/non-mapping YAML %j using only the applicable rules", (text) => {
        expect(rules(text)).toEqual([{ rule: "R4", line: 1 }, { rule: "R6", line: 1 }, { rule: "R6", line: 1 }]);
    });

    it("does not scan rule-looking text in an oversized shell block as workflow keys", () => {
        const text = `${BASE}      - run: |\n${"          echo 'uses: mutable; permissions: write-all; environment: staging'\n".repeat(20_000)}`;
        expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
        expect(rules(text)).toEqual([]);
    });

    it("reports every independent violation, including two rules at the same action", () => {
        const text = BASE.replace("{ contents: read }", "write-all")
            .replace("    runs-on:", "    permissions: write-all\n    environment: staging\n    runs-on:")
            .replace(`actions/checkout@${SHA} # v4.2.2`, "actions/checkout@v4");
        expect(rules(text)).toEqual([
            { rule: "R5", line: 3 }, { rule: "R5", line: 6 }, { rule: "R7", line: 7 },
            { rule: "R2", line: 10 }, { rule: "R3", line: 10 },
        ]);
    });
});

function withDirectory(run: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), "wp2-workflows-qa-"));
    try {
        run(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

function cli(directory: string, cwd = repository) {
    return spawnSync(process.execPath, [validatorPath, directory], { cwd, encoding: "utf8", timeout: 15_000 });
}

describe("WP2 validator command-line contract", () => {
    it("returns 0 for clean workflows and ignores non-workflow files and subdirectories", () => {
        withDirectory((directory) => {
            writeFileSync(join(directory, "clean.yml"), BASE);
            writeFileSync(join(directory, "notes.txt"), "[ malformed");
            mkdirSync(join(directory, "nested"));
            writeFileSync(join(directory, "nested", "bad.yml"), "[ malformed");
            const result = cli(directory);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain("1 workflow file(s)");
        });
    });

    it("returns 1 and prints the file and line for every violation across all files", () => {
        withDirectory((directory) => {
            writeFileSync(join(directory, "a.yml"), BASE.replace("{ contents: read }", "write-all"));
            writeFileSync(join(directory, "b.yml"), BASE.replace(`actions/checkout@${SHA} # v4.2.2`, "actions/checkout@v4"));
            writeFileSync(join(directory, "c.yml"), `${BASE}broken: [\n`);
            const result = cli(directory);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(1);
            const lines = result.stdout.replaceAll("\\", "/").split(/\r?\n/).filter((line) => /: R[1-7] /.test(line));
            expect(lines).toHaveLength(4);
            expect(lines[0]).toContain("/a.yml:3: R5 ");
            expect(lines[1]).toContain("/b.yml:8: R2 ");
            expect(lines[2]).toContain("/b.yml:8: R3 ");
            expect(lines[3]).toContain("/c.yml:10: R1 ");
        });
    });

    it("defaults to the working directory's .github/workflows", () => {
        withDirectory((directory) => {
            const workflows = join(directory, ".github", "workflows");
            mkdirSync(workflows, { recursive: true });
            writeFileSync(join(workflows, "default.yml"), BASE.replace("{ contents: read }", "write-all"));
            const result = spawnSync(process.execPath, [validatorPath], { cwd: directory, encoding: "utf8", timeout: 15_000 });
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(1);
            expect(result.stdout).toContain(".github/workflows/default.yml:3: R5 ");
        });
    });

    it("keeps collecting R5/R7 errors when valid YAML contains a recursive environment", () => {
        withDirectory((directory) => {
            const text = BASE.replace("{ contents: read }", "write-all")
                .replace("    runs-on:", "    environment: &environment\n      name: *environment\n    runs-on:");
            writeFileSync(join(directory, "recursive.yml"), text);
            const result = cli(directory);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(1);
            expect(result.stdout).toContain("recursive.yml:3: R5 ");
            expect(result.stdout).toContain("recursive.yml:7: R7 ");
            expect(result.stdout).not.toContain(": R1 ");
        });
    });
});

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
    needs?: string | string[];
    permissions?: Record<string, string>;
    steps?: Step[];
    strategy?: { matrix?: { language?: string[] } };
};
type Workflow = {
    name?: string;
    on: Record<string, { branches?: string[] } | Array<{ cron: string }> | null>;
    permissions: Record<string, string>;
    concurrency?: { group?: string; "cancel-in-progress"?: boolean };
    jobs: Record<string, Job>;
};
const workflowNames = ["ci", "codeql", "dependency-review", "scorecard", "container-scan"] as const;
function readWorkflow(name: string) {
    return load(readFileSync(join(artifactRoot, ".github/workflows", `${name}.yml`), "utf8")) as Workflow;
}
function steps(workflow: Workflow) {
    return Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
}
function action(workflow: Workflow, name: string) {
    const found = steps(workflow).find((step) => step.uses?.startsWith(`${name}@`));
    expect(found, `Missing ${name}`).toBeDefined();
    return found!;
}
function jobForAction(workflow: Workflow, name: string) {
    const found = Object.values(workflow.jobs).find((job) => job.steps?.some((step) => step.uses?.startsWith(`${name}@`)));
    expect(found, `Missing job running ${name}`).toBeDefined();
    return found!;
}
function permissionFor(workflow: Workflow, name: string) {
    return jobForAction(workflow, name).permissions ?? workflow.permissions;
}
function weekly(workflow: Workflow) {
    const schedule = workflow.on.schedule;
    expect(Array.isArray(schedule)).toBe(true);
    const crons = schedule as Array<{ cron: string }>;
    expect(crons).toHaveLength(1);
    expect(crons[0]?.cron.trim().split(/\s+/)).toEqual([
        expect.stringMatching(/^\d+$/), expect.stringMatching(/^\d+$/),
        "*", "*", expect.stringMatching(/^[0-7]$/),
    ]);
}

describe("WP2 actual workflow deliverables", () => {
    it.each(workflowNames)("%s.yml exists, parses, and satisfies R1-R7", (name) => {
        const path = join(artifactRoot, ".github/workflows", `${name}.yml`);
        expect(existsSync(path)).toBe(true);
        const text = readFileSync(path, "utf8");
        expect(readWorkflow(name).name).toEqual(expect.any(String));
        expect(rules(text)).toEqual([]);
    });

    it("ci.yml has both triggers, ref cancellation, Node 24 with npm caching, and read-only permissions", () => {
        const ci = readWorkflow("ci");
        expect(ci.on).toHaveProperty("pull_request");
        expect(ci.on.push).toEqual({ branches: ["main"] });
        expect(ci.concurrency?.group).toContain("${{ github.ref }}");
        expect(ci.concurrency?.["cancel-in-progress"]).toBe(true);
        expect(ci.permissions).toEqual({ contents: "read" });
        const nodeSteps = steps(ci).filter((step) => step.uses?.startsWith("actions/setup-node@"));
        expect(nodeSteps.length).toBeGreaterThan(0);
        for (const step of nodeSteps) {
            expect(String(step.with?.["node-version"])).toBe("24");
            expect(step.with?.cache).toBe("npm");
        }
    });

    it("ci.yml installs before both gates and builds only after its gate job", () => {
        const ci = readWorkflow("ci");
        const entries = Object.entries(ci.jobs);
        const gate = entries.find(([, job]) => job.steps?.some((step) => step.run === "npm run gate"));
        expect(gate).toBeDefined();
        const [gateId, gateJob] = gate!;
        const commands = (gateJob.steps ?? []).flatMap((step) => step.run ? [step.run] : []);
        expect(commands.indexOf("npm ci")).toBeGreaterThanOrEqual(0);
        expect(commands.indexOf("npm ci")).toBeLessThan(commands.indexOf("npm run gate"));
        expect(commands.indexOf("npm run gate:test")).toBeGreaterThan(commands.indexOf("npm run gate"));
        const build = entries.find(([, job]) => job.steps?.some((step) => /\bdocker build\b/.test(step.run ?? "")));
        expect(build).toBeDefined();
        expect([build![1].needs].flat()).toContain(gateId);
    });

    it("codeql.yml scans both languages weekly and on PR/main with security-extended queries", () => {
        const codeql = readWorkflow("codeql");
        expect(codeql.on).toHaveProperty("pull_request");
        expect(codeql.on.push).toEqual({ branches: ["main"] });
        weekly(codeql);
        const job = jobForAction(codeql, "github/codeql-action/init");
        expect(job.strategy?.matrix?.language?.slice().sort()).toEqual(["javascript-typescript", "python"]);
        expect(action(codeql, "github/codeql-action/init").with?.languages).toBe("${{ matrix.language }}");
        expect(action(codeql, "github/codeql-action/init").with?.queries).toBe("security-extended");
        action(codeql, "github/codeql-action/analyze");
        expect(permissionFor(codeql, "github/codeql-action/analyze")).toEqual({ "security-events": "write", contents: "read", actions: "read" });
    });

    it("dependency-review.yml gates PRs at high severity with the required permissions", () => {
        const review = readWorkflow("dependency-review");
        expect(review.on).toHaveProperty("pull_request");
        expect(action(review, "actions/dependency-review-action").with?.["fail-on-severity"]).toBe("high");
        expect(permissionFor(review, "actions/dependency-review-action")).toEqual({ contents: "read", "pull-requests": "write" });
    });

    it("scorecard.yml runs weekly/manually and uploads its generated SARIF with the required permissions", () => {
        const scorecard = readWorkflow("scorecard");
        weekly(scorecard);
        expect(scorecard.on).toHaveProperty("workflow_dispatch");
        const scan = action(scorecard, "ossf/scorecard-action");
        expect(scan.with?.results_format).toBe("sarif");
        expect(scan.with?.results_file).toEqual(expect.any(String));
        expect(action(scorecard, "github/codeql-action/upload-sarif").with?.sarif_file).toBe(scan.with?.results_file);
        expect(permissionFor(scorecard, "ossf/scorecard-action")).toEqual({ "security-events": "write", "id-token": "write", contents: "read" });
    });

    it("container-scan.yml builds and scans the same image on PRs/weekly and uploads its SARIF", () => {
        const container = readWorkflow("container-scan");
        weekly(container);
        expect(container.on).toHaveProperty("pull_request");
        const scan = action(container, "aquasecurity/trivy-action");
        expect(scan.with?.format).toBe("sarif");
        expect(scan.with?.["image-ref"]).toEqual(expect.any(String));
        const buildIndex = steps(container).findIndex((step) => /\bdocker build\b/.test(step.run ?? ""));
        const scanIndex = steps(container).indexOf(scan);
        expect(buildIndex).toBeGreaterThanOrEqual(0);
        expect(buildIndex).toBeLessThan(scanIndex);
        expect(steps(container)[buildIndex]?.run).toContain(String(scan.with?.["image-ref"]));
        expect(scan.with?.output).toEqual(expect.any(String));
        expect(action(container, "github/codeql-action/upload-sarif").with?.sarif_file).toBe(scan.with?.output);
        expect(permissionFor(container, "aquasecurity/trivy-action")).toEqual({ "security-events": "write", contents: "read" });
    });
});

type Update = {
    "package-ecosystem": string;
    directory: string;
    schedule?: { interval?: string };
    groups?: Record<string, { patterns?: string[]; "update-types"?: string[] }>;
    ignore?: Array<{ "dependency-name": string; versions?: string[]; "update-types"?: string[] }>;
};
function dependabot() {
    return load(readFileSync(join(artifactRoot, ".github/dependabot.yml"), "utf8")) as { version: number; updates: Update[] };
}
describe("WP2 actual Dependabot policy", () => {
    it("uses version 2 and exactly the four named ecosystems/directories", () => {
        const config = dependabot();
        expect(config.version).toBe(2);
        expect(config.updates.map((update) => [update["package-ecosystem"], update.directory]).sort()).toEqual([
            ["docker", "/"], ["github-actions", "/"], ["npm", "/"], ["pip", "/tools"],
        ]);
    });

    it.each(["npm", "pip", "docker", "github-actions"])("%s updates weekly, groups minor/patch, and leaves majors separate", (ecosystem) => {
        const update = dependabot().updates.find((entry) => entry["package-ecosystem"] === ecosystem);
        expect(update).toBeDefined();
        expect(update?.schedule?.interval).toBe("weekly");
        const groups = Object.values(update?.groups ?? {});
        expect(groups.length).toBeGreaterThan(0);
        expect(groups.some((group) => group.patterns?.includes("*") && group["update-types"]?.includes("minor") && group["update-types"]?.includes("patch"))).toBe(true);
        for (const group of groups) {
            expect(group["update-types"]).toBeDefined();
            expect(group["update-types"]).not.toContain("major");
        }
    });

    it.each([["npm", "morgan"], ["pip", "requests"]])("keeps the deliberately vulnerable %s pin %s ignored", (ecosystem, dependency) => {
        const update = dependabot().updates.find((entry) => entry["package-ecosystem"] === ecosystem);
        const ignored = update?.ignore?.find((entry) => entry["dependency-name"] === dependency);
        expect(ignored).toBeDefined();
        // No version/update-type restriction: all upgrades of the deliberate pin remain ignored.
        expect(ignored?.versions).toBeUndefined();
        expect(ignored?.["update-types"]).toBeUndefined();
    });
});
