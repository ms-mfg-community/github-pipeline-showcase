#!/usr/bin/env node
// Workflow validation — SPEC.md §6.1. This is gate leg 6 (§2.2) and the WP2 acceptance mechanism:
//
//   node scripts/validate-workflows.mjs [workflows-directory]
//
// It reads every workflow in .github/workflows (the working directory's, or else this repository's; or the
// directory given) and enforces exactly seven rules, R1 to R7. They are the complete set the spec defines;
// this script adds none, because an extra rule is a false blocker waiting to happen.
//
//   R1  the file parses as YAML
//   R2  every `uses:` that is not a local ./ path matches owner/repo(/path)?@<40-hex-sha>
//   R3  every such `uses:` carries a trailing comment naming the version, e.g. `# v4.2.2`
//   R4  the workflow declares a top-level `permissions:` block
//   R5  no workflow or job uses `permissions: write-all`
//   R6  the workflow declares `name:` and at least one trigger under `on:`
//   R7  a job with an `environment:` names exactly one of dev, test or prod
//
// Every violation is printed as `file:line: Rn message`. Exit code 1 means at least one violation, 0
// means clean, and 2 means the validator could not run at all (no YAML parser, bad usage, a fault in
// this script) — which says nothing about the workflows and so is kept apart from 1.
//
// How a file is read: js-yaml decides what the file MEANS, and every rule below reads its parsed
// document. js-yaml also says where each node sits: its `listener` option reports every node as it is
// composed, so a rule can ask which key and value nodes a mapping was written with, and on which line,
// without this script re-reading the YAML grammar. Block or flow style, quoted or escaped keys, aliases
// and merge keys all reach the rules as the parser resolved them. The raw text is consulted for two
// things only: a line number, and the comment at the end of a line (a parser discards comments, and R3
// is about one). A comment belongs to an entry when it ends a line the entry was written on: the line of
// its key, the line its value starts on, or the line a quoted value closes on (a double-quoted scalar can
// continue over a line break). A `uses:` the parse gives no position for makes R3 fail closed and say why,
// so a limitation here can never hide a violation. (`listener` is js-yaml's parse-event hook; it is not in
// the README, so test/validate-workflows.test.ts pins the behaviour this script relies on from it, and an
// upgrade that changes that behaviour fails the gate there rather than quietly misplacing a line.)
//
// Only the parser's own verdict is an R1. An error from anywhere else is a fault in this script, and it
// is never passed off as a finding about the workflow: it ends the run with exit code 2.
//
// js-yaml is not declared in package.json: it arrives as a dependency of ESLint, so a gate that has run
// `npm run setup` always has it. If it is missing, this script says so and exits 2 instead of guessing.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
export const ENVIRONMENTS = Object.freeze(["dev", "test", "prod"]);

// owner/repo, then an optional path inside the repository, then @ and a full 40-character commit SHA.
const PINNED_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-fA-F]{40}$/;
// A comment that names a version: v4.2.2, 4.2.2, v4, release-1.2 ... but not "pinned" or "latest".
const VERSION_COMMENT = /\bv?\d+(?:\.\d+)*\b/;

let loadYaml;
let yamlUnavailable;
try {
    ({ load: loadYaml } = await import("js-yaml"));
} catch (error) {
    yamlUnavailable = error;
}

// --- the text itself: lines and comments -------------------------------------------------------------------
// The parse says WHICH node is which. The text is only asked two things: what line is this offset on, and
// is there a comment at the end of that line.

/** The offset of the first character at or after `i` that is neither whitespace nor part of a comment. */
function skipTrivia(text, i) {
    while (i < text.length) {
        const ch = text[i];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            i += 1;
        } else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
            while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i += 1;
        } else {
            break;
        }
    }
    return i;
}

/** The offset each line starts at. `\r\n`, `\n` and a lone `\r` all end a line, as they do for the parser. */
function lineStartsOf(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] !== "\n")) starts.push(i + 1);
    }
    return starts;
}

/** The 1-based line that holds `offset`. */
function lineAt(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= offset) low = mid;
        else high = mid - 1;
    }
    return low + 1;
}

/**
 * The comment at the end of the line that holds `from`, reading forward from `from`, or undefined.
 *
 * `from` must be where a node starts or where a scalar ends, never inside a scalar (the parse gives such
 * offsets), so quoting can be followed from there: a `#` inside a quoted string is text, not a comment, and a
 * quote still open when the line ends means any comment is on a later line, which is not this line's
 * trailing comment.
 */
function trailingComment(text, from) {
    let quote = null;
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\n" || ch === "\r") return undefined;
        const prev = i === 0 ? " " : text[i - 1];
        if (quote === "'") {
            if (ch === "'") {
                if (text[i + 1] === "'") i += 1;
                else quote = null;
            }
        } else if (quote === '"') {
            if (ch === "\\" && text[i + 1] !== "\n" && text[i + 1] !== "\r") i += 1;
            else if (ch === '"') quote = null;
        } else if ((ch === "'" || ch === '"') && (i === from || /[\s{[,:]/.test(prev))) {
            quote = ch;
        } else if (ch === "#" && /\s/.test(prev)) {
            let end = i;
            while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
            return text.slice(i + 1, end).trim();
        }
    }
    return undefined;
}

// --- where each entry was written -------------------------------------------------------------------------

/** Whether the next thing after `record`, past whitespace and comments, is the `:` that gives a key its value. */
const colonAfter = (source, record) => source[skipTrivia(source, record.end)] === ":";

/**
 * The property name the parser made from a key record: what String() makes of its value, as the parser does,
 * so a quoted, escaped, aliased or flow-sequence key (`[uses]: x`) is the key it was resolved to. A mapping
 * used as a key is "[object Object]", and is never asked to render itself, because it can carry a `toString`
 * of its own that is not callable. Undefined for a key that cannot be named without that risk.
 */
function keyText({ value }) {
    if (Array.isArray(value)) return value.every((item) => item === null || typeof item !== "object") ? String(value) : undefined;
    return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype ? "[object Object]" : String(value);
}

/**
 * The entries of a mapping, as a key record and a value record, from the records composed inside it.
 *
 * Those come as key, value, key, value only while every entry has a value. An entry written without one
 * (`{uses, name: x}`, a lone `? key`) is composed as a key and nothing else, so counting in twos would pair
 * `uses` with `name`. What tells the two cases apart is the `:` after the key, which the parser requires
 * for a value, so a key not followed by one has no value record.
 */
function pairsOf(source, kids) {
    const pairs = [];
    for (let i = 0; i < kids.length; i++) {
        const key = kids[i];
        pairs.push({ key, value: i + 1 < kids.length && colonAfter(source, key) ? kids[++i] : undefined });
    }
    return pairs;
}

/**
 * Gives the one-entry mappings of a sequence a record of their own, when the parser composed them without.
 *
 * A flow sequence can hold a mapping without braces: `[uses: x]` is `[{uses: x}]`. The parser builds that
 * mapping from the key's record and the value's record and reports no record for the mapping itself, so
 * those two sit among the sequence's own: one record for an ordinary entry, two for a pair (the second only
 * if a `:` follows the key). An entry that is the very value its record holds is ordinary; any other is a
 * pair, and the records for it are the ones that follow. The sequence's records must be used up exactly by
 * its entries. If they are not, they do not describe this sequence, and nothing is added rather than guessed.
 */
function addFlowPairs(source, { value: entries, kids }, nodes) {
    if (!Array.isArray(entries)) return;
    const made = [];
    let next = 0;
    for (const entry of entries) {
        const first = kids[next++];
        if (first === undefined) return;
        if (Object.is(first.value, entry)) continue;
        const second = colonAfter(source, first) ? kids[next++] : undefined;
        if (entry === null || typeof entry !== "object") return;
        made.push([
            entry,
            {
                kind: "mapping",
                value: entry,
                start: first.start,
                end: (second ?? first).end,
                kids: second === undefined ? [first] : [first, second],
                pairs: [{ key: first, value: second }],
            },
        ]);
    }
    if (next !== kids.length) return;
    for (const [entry, record] of made) nodes.set(entry, record);
}

/**
 * Parses `source` and keeps a record of how the parser composed it.
 *
 * js-yaml reports every node it composes through its `listener` option: once as the node starts, once as it
 * is complete, always properly nested. Each finished node becomes a record (its kind, its value, where it
 * started and where the parser stopped reading it, the records inside it). Collections are indexed by the
 * very object the parser returned for them, so a rule holding `jobs.build.steps[2]` can find the record it
 * was composed from however the file spelled it. An alias leads to the record of what it points at, because
 * the parser hands back that same object. A collection can be reported twice, an outer node wrapping the
 * inner one that holds its contents; the first to complete is the inner, and it is the one kept.
 *
 * The records are how the parser composed the file, which is not quite how the file is structured: a
 * mapping's entries are rebuilt from them (see `pairsOf`), and a one-entry mapping in a flow sequence is
 * given the record the parser did not (see `addFlowPairs`). What those do not recover is left unplaced, and
 * an unplaced `uses:` fails R3.
 *
 * Only a YAMLException leaves here as an R1. Anything else thrown on the way (including from a bug in this
 * recorder) propagates as the fault it is.
 *
 * @returns {{doc: unknown, positions: ReturnType<typeof positionsIn>}}
 */
function parseWithNodes(source, load) {
    const nodes = new Map(); // collection object -> the record that composed it
    const anchors = new Map(); // anchor name -> the record that defined it, as far as the parse has got
    const open = [{ kids: [] }];
    const aliasName = /\*([^\s,[\]{}]+)/y;

    const doc = load(source, {
        listener(event, state) {
            if (event === "open") {
                open.push({ start: state.position, kids: [] });
                return;
            }
            const node = open.pop();
            node.end = state.position; // after the closing quote of a quoted scalar; see `positionsIn` for the rest
            node.kind = state.kind; // "scalar", "mapping" or "sequence"; null for an empty node and for an alias
            node.value = state.result;
            if (node.kind === null && node.value !== null) {
                // An alias: the parser returned the value it points at. Remember where that was written.
                aliasName.lastIndex = skipTrivia(source, node.start);
                const name = aliasName.exec(source)?.[1];
                node.target = name === undefined ? undefined : anchors.get(name);
            }
            if ((node.kind === "mapping" || node.kind === "sequence") && !nodes.has(node.value)) {
                nodes.set(node.value, node);
                if (node.kind === "mapping") node.pairs = pairsOf(source, node.kids);
                else addFlowPairs(source, node, nodes);
            }
            if (state.anchor !== null) anchors.set(state.anchor, node);
            open[open.length - 1].kids.push(node);
        },
    });
    return { doc, positions: positionsIn(source, nodes) };
}

/** Answers "where was this written?" for the objects of one parse. */
function positionsIn(source, nodes) {
    const starts = lineStartsOf(source);
    const lineOf = (node) => lineAt(starts, skipTrivia(source, node.start));
    const isCollection = (value) => value !== null && typeof value === "object";
    // An empty node (`uses:` with nothing after it) has no text of its own. Skipping trivia from its start
    // would land on whatever entry comes next and lend that entry's line, and its comment, to this one.
    const hasText = (node) => node.kind !== null || node.value !== null;

    /**
     * The key and value records `object` was written with for `key`; the value record is undefined for an
     * entry written without a value. A mapping that inherits an entry through a merge key (`<<: *base`) was
     * not written with it, so the search follows the merge to where it was. A record only counts when its
     * value is the very value the parser stored: a position is trusted only when it provably describes the
     * thing the rules are looking at.
     */
    function entry(object, key, seen = new Set()) {
        const node = isCollection(object) ? nodes.get(object) : undefined;
        if (node?.kind !== "mapping" || seen.has(object)) return undefined;
        seen.add(object);
        const stored = (pair) => Object.is(pair.value?.value ?? null, object[key]);
        const own = node.pairs.find((pair) => keyText(pair.key) === key && stored(pair));
        if (own) return own;
        for (const pair of node.pairs) {
            if (keyText(pair.key) !== "<<") continue;
            for (const merged of [pair.value?.value].flat()) {
                const inherited = entry(merged, key, seen);
                if (inherited && stored(inherited)) return inherited;
            }
        }
        return undefined;
    }

    /**
     * Where to start reading for the comment at the end of a line that `node` was written on: where it
     * starts and, for a scalar, where it ends.
     *
     * The end matters because a quoted scalar can run over several lines (an escaped line break continues a
     * double-quoted one), and its comment then follows the closing quote, on a line it did not start on.
     *
     * Two kinds of node are not read from their end, because the parser stops reading them after the line
     * break that closes them, past the next line's indentation, and reading on from there would hand this
     * entry the comment of the line after it. An alias or a collection is not a scalar. A block scalar is,
     * and is told apart by no text of it coming before its end on the line the end is on.
     */
    function readingPoints(node) {
        const points = [skipTrivia(source, node.start)];
        const endsAfterText = /\S/.test(source.slice(starts[lineAt(starts, node.end) - 1], node.end));
        if (node.kind === "scalar" && endsAfterText) points.push(node.end);
        return points;
    }

    return {
        entry,
        /** The line an entry's key was written on, or undefined if the parse gave no position for it. */
        entryLine(object, key) {
            const found = entry(object, key);
            return found && lineOf(found.key);
        },
        /** The line a record starts on. */
        line: lineOf,
        /** The line a collection starts on, or undefined if the parse did not compose it as a node. */
        lineOfObject(object) {
            const node = isCollection(object) ? nodes.get(object) : undefined;
            return node && lineOf(node);
        },
        /**
         * Whether the entry carries a comment naming a version, on a line the entry itself was written on:
         * where its key is, where its value starts (`uses:` may be followed by a line break) and ends (a quoted
         * value can continue over a line break), or, if the value is an alias, the same for the value it
         * points at, which is where the comment was written.
         */
        hasVersionComment({ key, value }) {
            const written = [key];
            if (value !== undefined) {
                if (hasText(value)) written.push(value);
                if (value.target !== undefined) written.push(value.target);
            }
            return written.some((node) => readingPoints(node).some((from) => VERSION_COMMENT.test(trailingComment(source, from) ?? "")));
        },
    };
}

// --- the rules ---------------------------------------------------------------------------------------------

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A short rendering of a parsed value for a diagnostic.
 *
 * It has to cope with whatever the parser can build, and aliases let a small file build a value that is
 * recursive (`&a {self: *a}`) or, written out in full, exponentially large. So it never writes anything out
 * in full: it visits a few nodes, shows a few entries of each, and marks a loop instead of following it.
 * JSON.stringify does none of that, and throws on the first loop.
 */
function show(value) {
    let budget = 20; // collections to open; past that, `...`
    const render = (node, ancestors) => {
        if (typeof node === "string") return JSON.stringify(node);
        if (typeof node !== "object" || node === null) return String(node);
        if (ancestors.includes(node)) return "[Circular]";
        if (budget <= 0) return "...";
        budget -= 1;
        const inside = [...ancestors, node];
        if (Array.isArray(node)) {
            const items = node.slice(0, 5).map((item) => render(item, inside));
            return `[${items.join(", ")}${node.length > 5 ? ", ..." : ""}]`;
        }
        const prototype = Object.getPrototypeOf(node);
        if (prototype !== Object.prototype && prototype !== null) return Object.prototype.toString.call(node); // a Date, say
        const keys = Object.keys(node);
        const entries = keys.slice(0, 5).map((key) => `${key}: ${render(node[key], inside)}`);
        return `{${entries.join(", ")}${keys.length > 5 ? ", ..." : ""}}`;
    };
    const text = typeof value === "string" ? value : render(value, []);
    return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

/**
 * Whether `name:` says something. Any value that renders as text does, however odd (`name: 123`); an empty or
 * missing one does not. The conversion is guarded because the parser can build values that cannot be
 * converted, such as a mapping whose own `toString` is not callable, and that is not an empty name.
 */
function hasName(name) {
    if (name === undefined || name === null) return false;
    try {
        return String(name).trim() !== "";
    } catch {
        return true;
    }
}

function hasTrigger(on) {
    if (typeof on === "string") return on.trim() !== "";
    if (Array.isArray(on)) return on.some((trigger) => typeof trigger === "string" && trigger.trim() !== "");
    if (isMapping(on)) return Object.keys(on).length > 0;
    return false;
}

/**
 * Every `uses:` in the workflow: reusable-workflow calls on a job, and the steps of each job. `owner` is the
 * mapping the `uses:` belongs to, which is how its entry is found; `fallbackLine` is where to point if the
 * parse gave no position for that entry.
 */
function* usesSites(jobs, positions, jobsLine) {
    for (const [jobId, job] of Object.entries(jobs)) {
        if (!isMapping(job)) continue;
        const jobLine = positions.entryLine(jobs, jobId) ?? jobsLine;
        if (Object.hasOwn(job, "uses")) {
            yield { label: `job "${jobId}"`, owner: job, value: job.uses, fallbackLine: jobLine };
        }
        if (!Array.isArray(job.steps)) continue;
        for (const [i, step] of job.steps.entries()) {
            if (!isMapping(step) || !Object.hasOwn(step, "uses")) continue;
            const fallbackLine = positions.lineOfObject(step) ?? positions.lineOfObject(job.steps) ?? jobLine;
            yield { label: `job "${jobId}", step ${i + 1}`, owner: step, value: step.uses, fallbackLine };
        }
    }
}

/**
 * Checks one workflow's text against R1 to R7.
 *
 * @param {string} text   the file's contents
 * @param {Function} load js-yaml's load(); injectable so the rules can be exercised on their own
 * @returns {{line: number, rule: string, message: string}[]}  sorted by line, then rule
 */
export function validateWorkflowText(text, load = loadYaml) {
    if (typeof load !== "function") throw new Error("validate-workflows: no YAML parser is available");
    const source = text.replace(/^\uFEFF/, "");

    // R1 — everything else needs a parsed document, so a file that does not parse stops here. Only the
    // parser's own verdict is an R1: any other error is a fault in this script, and blaming the file for it
    // would be a false finding, so it is rethrown.
    let parsed;
    try {
        parsed = parseWithNodes(source, load);
    } catch (error) {
        if (error?.name !== "YAMLException") throw error;
        const line = typeof error.mark?.line === "number" ? error.mark.line + 1 : 1;
        return [{ line, rule: "R1", message: `is not valid YAML: ${error.reason ?? error.message}` }];
    }
    const { doc, positions } = parsed;

    const violations = [];
    const report = (line, rule, message) => violations.push({ line, rule, message });
    const top = isMapping(doc) ? doc : {};

    // R4 — a top-level permissions block, so a job never silently inherits the repository default.
    const permissionsLine = positions.entryLine(top, "permissions") ?? 1;
    if (!Object.hasOwn(top, "permissions")) {
        report(1, "R4", "has no top-level `permissions:` block; declare least privilege, e.g. `permissions: { contents: read }`");
    } else if (top.permissions === null || top.permissions === undefined) {
        report(permissionsLine, "R4", "declares `permissions:` with no value; use `{}` for none");
    }

    // R5 — write-all, at the workflow level or on any job.
    const isWriteAll = (value) => typeof value === "string" && value.trim().toLowerCase() === "write-all";
    if (isWriteAll(top.permissions)) {
        report(permissionsLine, "R5", "uses `permissions: write-all`; list only the scopes the workflow needs");
    }

    // R6 — a name, and at least one trigger.
    if (!hasName(top.name)) {
        report(1, "R6", "does not declare `name:`");
    }
    if (!hasTrigger(top.on)) {
        report(positions.entryLine(top, "on") ?? 1, "R6", "does not declare a trigger; `on:` is missing or empty");
    }

    const jobs = isMapping(top.jobs) ? top.jobs : {};
    const jobsLine = positions.entryLine(top, "jobs") ?? 1;

    // R5 and R7 — per job.
    for (const [jobId, job] of Object.entries(jobs)) {
        if (!isMapping(job)) continue;
        const jobLine = positions.entryLine(jobs, jobId) ?? jobsLine;
        if (isWriteAll(job.permissions)) {
            report(positions.entryLine(job, "permissions") ?? jobLine, "R5", `job "${jobId}" uses \`permissions: write-all\`; list only the scopes it needs`);
        }
        if (Object.hasOwn(job, "environment")) {
            const environment = job.environment;
            const named = isMapping(environment) ? environment.name : environment;
            if (typeof named !== "string" || !ENVIRONMENTS.includes(named)) {
                const nameLine = isMapping(environment) ? positions.entryLine(environment, "name") : undefined;
                const line = nameLine ?? positions.entryLine(job, "environment") ?? jobLine;
                report(line, "R7", `job "${jobId}" has environment ${show(named ?? environment)}; it must be exactly one of ${ENVIRONMENTS.join(", ")}`);
            }
        }
    }

    // R2 and R3 — every external `uses:`, whether on a step or on a job that calls a reusable workflow.
    for (const { label, owner, value, fallbackLine } of usesSites(jobs, positions, jobsLine)) {
        if (typeof value === "string" && value.startsWith("./")) continue; // a local action or workflow
        const entry = positions.entry(owner, "uses");
        const line = entry ? positions.line(entry.key) : fallbackLine;
        const shown = show(value);
        if (typeof value !== "string" || !PINNED_USES.test(value)) {
            report(line, "R2", `${label}: \`uses: ${shown}\` is not pinned to a commit; expected owner/repo[/path]@<40-hex-sha>`);
        }
        if (!entry) {
            // No position means the comment cannot be shown to exist, so the rule fails rather than passes.
            report(line, "R3", `${label}: \`uses: ${shown}\` could not be located in the source, so its trailing version comment could not be checked`);
        } else if (!positions.hasVersionComment(entry)) {
            report(line, "R3", `${label}: \`uses: ${shown}\` has no trailing version comment such as \`# v4.2.2\``);
        }
    }

    return violations.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

// --- running it ---------------------------------------------------------------------------------------------

export const formatViolation = ({ file, line, rule, message }) => `${file}:${line}: ${rule} ${message}`;

/** The path as the user would type it: relative to the working directory, with forward slashes. */
function displayPath(file) {
    const rel = relative(process.cwd(), file);
    return (rel === "" || rel.startsWith("..") || isAbsolute(rel) ? file : rel).replaceAll("\\", "/");
}

/** Validates every .yml / .yaml file directly inside `directory`. */
export function validateDirectory(directory, load = loadYaml) {
    const names = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const violations = [];
    for (const name of names) {
        const file = displayPath(join(directory, name));
        let text;
        try {
            text = readFileSync(join(directory, name), "utf8");
        } catch (error) {
            // A workflow that cannot be read cannot be shown to meet any rule. Only the read is guarded here:
            // a fault while checking a file that WAS read is not about the file, and must not look like it.
            violations.push({ file, line: 1, rule: "R1", message: `could not be read: ${error.message}` });
            continue;
        }
        for (const violation of validateWorkflowText(text, load)) violations.push({ file, ...violation });
    }
    return { files: names, violations };
}

const USAGE =
    "usage: node scripts/validate-workflows.mjs [workflows-directory]\n" +
    "  default: .github/workflows in the current directory, or else in the repository this script lives in";

/** The workflows directory to check when none is given: the working directory's, then this repository's. */
function defaultDirectory() {
    const inWorkingDirectory = resolve(process.cwd(), ".github", "workflows");
    return existsSync(inWorkingDirectory) ? inWorkingDirectory : WORKFLOWS_DIR;
}

export function main(argv = process.argv.slice(2), log = console.log, logError = console.error) {
    if (argv.includes("-h") || argv.includes("--help")) {
        log(USAGE);
        return 0;
    }
    if (argv.length > 1 || argv.some((arg) => arg.startsWith("-"))) {
        logError(`validate-workflows: unexpected arguments: ${argv.join(" ")}\n${USAGE}`);
        return 2;
    }
    if (!loadYaml) {
        logError(
            `validate-workflows: cannot load the YAML parser "js-yaml" (${yamlUnavailable?.code ?? "unknown error"}). ` +
                "It is installed with ESLint; run: npm run setup",
        );
        return 2;
    }

    const directory = argv[0] ? resolve(argv[0]) : defaultDirectory();
    let result;
    try {
        result = validateDirectory(directory);
    } catch (error) {
        if (error?.code === "ENOENT" && !argv[0]) {
            log(`validate-workflows: no ${displayPath(directory)} directory — no workflows to check`);
            return 0;
        }
        // A file-system error carries a string `code`: the directory could not be read. Anything else is a
        // fault in this script. Neither says anything about the workflows, so neither is reported as a violation.
        logError(
            typeof error?.code === "string"
                ? `validate-workflows: cannot read ${displayPath(directory)}: ${error.message}`
                : `validate-workflows: internal error, the workflows were not checked: ${error?.stack ?? error}`,
        );
        return 2;
    }

    const { files, violations } = result;
    for (const violation of violations) log(formatViolation(violation));
    if (violations.length > 0) {
        const affected = new Set(violations.map((v) => v.file)).size;
        log(`validate-workflows: ${violations.length} violation(s) in ${affected} of ${files.length} file(s) — FAILED`);
        return 1;
    }
    log(
        files.length === 0
            ? `validate-workflows: no workflow files found in ${displayPath(directory)} — nothing to check`
            : `validate-workflows: ${files.length} workflow file(s) checked, no violations — PASSED`,
    );
    return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
