#!/usr/bin/env node
// Smoke test — SPEC.md §7.2.
//
// Checks that a running instance of the widget service honours every row of the §5.3 HTTP contract.
// The CD workflows run it against an environment once deploy.mjs has brought that environment up, and
// `deploy.mjs --self-test` runs it against each throwaway environment it starts.
//
// Usage:  node scripts/smoke.mjs --base-url <url> [--timeout <ms>]
//
// Exit codes: 0 every check passed; 1 a check failed or the instance could not be reached; 2 bad usage.
//
// The checks create two widgets and delete them again, so an instance is left as it was found. Every
// request goes down one keep-alive socket, one after another: a whole run is a single TCP connection
// however many requests it makes.

import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const DEFAULT_TIMEOUT_MS = 10_000;

const USAGE = `Usage: node scripts/smoke.mjs --base-url <url> [--timeout <ms>]

  --base-url  where the instance is listening, for example http://127.0.0.1:8080
  --timeout   per-request timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})
`;

// §5.3: every response is JSON in exactly this form, except GET / which is HTML.
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const NAME_MAX_LENGTH = 64;
const NOT_FOUND = Object.freeze({ error: "not_found" });

export class UsageError extends Error {
    name = "UsageError";
}

/** An observation of the instance that contradicts SPEC.md §5.3. */
export class SmokeFailure extends Error {
    name = "SmokeFailure";
}

// --- assertions --------------------------------------------------------------

const show = (value) => JSON.stringify(value);
const preview = (text) => show(text.length > 160 ? `${text.slice(0, 160)}…` : text);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function expect(condition, message) {
    if (!condition) throw new SmokeFailure(message);
}

function parseBody(response, label) {
    try {
        return JSON.parse(response.text);
    } catch {
        throw new SmokeFailure(`${label}: the body is not valid JSON (${preview(response.text)})`);
    }
}

function expectStatus(response, status, label) {
    expect(response.status === status, `${label}: expected HTTP ${status}, got ${response.status} (${preview(response.text)})`);
}

function expectJson(response, status, label) {
    expectStatus(response, status, label);
    const type = String(response.headers["content-type"] ?? "").toLowerCase();
    expect(type === JSON_CONTENT_TYPE, `${label}: expected content-type ${JSON_CONTENT_TYPE}, got ${show(type)}`);
    return parseBody(response, label);
}

function expectNotFound(response, label) {
    const body = expectJson(response, 404, label);
    expect(isDeepStrictEqual(body, NOT_FOUND), `${label}: expected ${show(NOT_FOUND)}, got ${show(body)}`);
}

function expectWidget(widget, label) {
    expect(isRecord(widget), `${label}: expected a widget object, got ${show(widget)}`);
    expect(typeof widget.id === "string" && UUID_V4.test(widget.id), `${label}: id ${show(widget.id)} is not a UUID v4`);
    expect(
        typeof widget.name === "string" && widget.name.trim().length >= 1 && widget.name.trim().length <= NAME_MAX_LENGTH,
        `${label}: name ${show(widget.name)} is not 1 to ${NAME_MAX_LENGTH} characters after trimming`,
    );
    expect(Number.isInteger(widget.quantity) && widget.quantity >= 0, `${label}: quantity ${show(widget.quantity)} is not an integer >= 0`);
    expect(
        typeof widget.createdAt === "string" && ISO_8601_UTC.test(widget.createdAt) && !Number.isNaN(Date.parse(widget.createdAt)),
        `${label}: createdAt ${show(widget.createdAt)} is not an ISO-8601 UTC timestamp`,
    );
}

// --- HTTP client -------------------------------------------------------------

// What cancelling a request rejects with. It has the name and the code of the AbortError that Node's own streams raise,
// so a caller sees the same error however far the request had got.
class AbortError extends Error {
    name = "AbortError";
    code = "ABORT_ERR";
}

/**
 * An HTTP client bound to one instance. All requests share a single keep-alive socket and are sent one at
 * a time (a request made while another is still being answered waits its turn), so using it costs one TCP
 * connection in total, unless a request that is in flight is cancelled: that closes the socket it was using,
 * and the next request opens a new one. A request cancelled before it has the socket never used it, and
 * leaves it to the response that does.
 *
 * `timeoutMs` is an idle timeout, not a deadline. It fires when the socket has been silent that long, so a
 * response that keeps trickling in never trips it. A caller that needs a deadline cancels the request itself,
 * with the `signal` option of `request`.
 *
 * @param {string} baseUrl
 * @param {{ timeoutMs?: number }} [options]
 */
export function createClient(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    let base;
    try {
        base = new URL(baseUrl);
    } catch {
        throw new UsageError(`--base-url is not a URL: ${show(baseUrl)}`);
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
        throw new UsageError(`--base-url must be an http:// or https:// URL, got ${show(baseUrl)}`);
    }
    const transport = base.protocol === "https:" ? https : http;
    const agent = new transport.Agent({ keepAlive: true, maxSockets: 1 });

    /**
     * Sends one request and resolves with the whole response. A JSON `body` is sent as the request body.
     *
     * Aborting `signal` cancels the request, wherever it has got to, and the promise rejects with an AbortError at
     * once. A request that has not been sent is never sent. One in flight has its connection closed. One waiting for
     * the client's single socket, behind a response that has not ended, does not wait for that response: it is
     * dropped, and the response ahead of it carries on.
     *
     * @param {string} method
     * @param {string} path
     * @param {unknown} [body]
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, text: string }>}
     */
    function request(method, path, body, { signal } = {}) {
        return new Promise((resolve, reject) => {
            const abortError = () => new AbortError("The operation was aborted", { cause: signal.reason });
            if (signal?.aborted) {
                reject(abortError());
                return;
            }

            // Whichever way the request ends, it lets go of the signal, so one signal can serve any number of requests.
            const settle = (result) => {
                signal?.removeEventListener("abort", cancel);
                resolve(result);
            };
            const fail = (error) => {
                signal?.removeEventListener("abort", cancel);
                reject(error);
            };
            // This promise is settled here, when the signal aborts, and is not left to the request. A request that is
            // waiting in the agent's queue for the socket says nothing, not even that it was aborted, until that socket
            // is free, and the response using it may never end. The request is destroyed all the same: that closes the
            // connection of one in flight, and makes the agent pass over a queued one, unsent, when the socket does come free.
            function cancel() {
                const error = abortError();
                outgoing.destroy(error);
                fail(error);
            }

            const payload = body === undefined ? undefined : JSON.stringify(body);
            const headers =
                payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
            const outgoing = transport.request(new URL(path, base), { method, agent, headers }, (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.once("error", fail);
                response.once("end", () =>
                    settle({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }),
                );
            });
            outgoing.setTimeout(timeoutMs, () => {
                outgoing.destroy(Object.assign(new Error(`${method} ${path} timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
            });
            // This stays attached once the promise has settled. A cancelled request is settled above before it has said
            // anything, and reports its error when it is torn down: for a queued one, after the response ahead of it has
            // ended. An error event that nothing listens for crashes the process.
            outgoing.on("error", fail);
            signal?.addEventListener("abort", cancel, { once: true });
            if (payload !== undefined) outgoing.write(payload);
            outgoing.end();
        });
    }

    return { baseUrl: base.href, request, close: () => agent.destroy() };
}

// --- the checks: one per row of the §5.3 table, plus one per validation failure -----------

const INVALID_PAYLOADS = Object.freeze([
    ["a missing name", { quantity: 1 }],
    ["an empty name", { name: "", quantity: 1 }],
    ["a name that is empty after trimming", { name: "   ", quantity: 1 }],
    [`a name longer than ${NAME_MAX_LENGTH} characters`, { name: "x".repeat(NAME_MAX_LENGTH + 1), quantity: 1 }],
    ["a missing quantity", { name: "smoke" }],
    ["a negative quantity", { name: "smoke", quantity: -1 }],
    ["a quantity that is not an integer", { name: "smoke", quantity: 1.5 }],
]);

async function createWidget(client, payload, label, created) {
    const response = await client.request("POST", "/api/widgets", payload);
    const widget = expectJson(response, 201, label);
    expectWidget(widget, label);
    created.add(widget.id);
    return widget;
}

async function deleteWidget(client, widget, label, created) {
    const response = await client.request("DELETE", `/api/widgets/${widget.id}`);
    expectStatus(response, 204, label);
    expect(response.text === "", `${label}: a 204 must have an empty body, got ${preview(response.text)}`);
    created.delete(widget.id);
}

export const CHECKS = Object.freeze([
    {
        name: "GET /healthz",
        async run({ client }) {
            const body = expectJson(await client.request("GET", "/healthz"), 200, "GET /healthz");
            expect(
                isRecord(body) && body.status === "ok" && typeof body.uptimeSeconds === "number",
                `GET /healthz: expected {"status":"ok","uptimeSeconds":<number>}, got ${show(body)}`,
            );
        },
    },
    {
        name: "GET /api/version",
        async run({ client }) {
            const body = expectJson(await client.request("GET", "/api/version"), 200, "GET /api/version");
            for (const key of ["version", "commit", "environment"]) {
                expect(isRecord(body) && typeof body[key] === "string", `GET /api/version: ${key} must be a string, got ${show(body)}`);
            }
        },
    },
    {
        name: "GET /api/widgets",
        async run({ client }) {
            const body = expectJson(await client.request("GET", "/api/widgets"), 200, "GET /api/widgets");
            expect(isRecord(body) && Array.isArray(body.items), `GET /api/widgets: expected {"items":[...]}, got ${show(body)}`);
            for (const item of body.items) expectWidget(item, "GET /api/widgets item");
        },
    },
    {
        name: "POST /api/widgets rejects every invalid payload with 400",
        async run({ client }) {
            for (const [description, payload] of INVALID_PAYLOADS) {
                const label = `POST /api/widgets with ${description}`;
                const body = expectJson(await client.request("POST", "/api/widgets", payload), 400, label);
                expect(isRecord(body) && body.error === "invalid_payload", `${label}: expected error "invalid_payload", got ${show(body)}`);
                expect(
                    Array.isArray(body.details) && body.details.length > 0 && body.details.every((detail) => typeof detail === "string"),
                    `${label}: details must be a non-empty array of strings, got ${show(body.details)}`,
                );
            }
        },
    },
    {
        name: "widget lifecycle: POST, GET by id, list, DELETE, then 404",
        async run({ client }) {
            const created = new Set();
            try {
                // A client-supplied id and createdAt are ignored, not an error (§5.3).
                const name = `smoke-${randomUUID().slice(0, 8)}`;
                const widget = await createWidget(
                    client,
                    { name, quantity: 3, id: "client-chosen-id", createdAt: "2000-01-01T00:00:00.000Z" },
                    "POST /api/widgets",
                    created,
                );
                expect(widget.name === name && widget.quantity === 3, `POST /api/widgets: the widget does not echo the request: ${show(widget)}`);
                expect(widget.createdAt !== "2000-01-01T00:00:00.000Z", "POST /api/widgets: a client-supplied createdAt must be ignored");

                // The limits §5.3 allows: a 64-character name and a quantity of 0.
                const boundary = await createWidget(client, { name: "w".repeat(NAME_MAX_LENGTH), quantity: 0 }, "POST /api/widgets at the limits", created);
                await deleteWidget(client, boundary, "DELETE /api/widgets/:id (limits widget)", created);

                const fetched = expectJson(await client.request("GET", `/api/widgets/${widget.id}`), 200, "GET /api/widgets/:id");
                expect(isDeepStrictEqual(fetched, widget), `GET /api/widgets/:id: expected ${show(widget)}, got ${show(fetched)}`);

                const list = expectJson(await client.request("GET", "/api/widgets"), 200, "GET /api/widgets after POST");
                expect(
                    Array.isArray(list.items) && list.items.some((item) => isDeepStrictEqual(item, widget)),
                    "GET /api/widgets: the widget that was just created is not listed",
                );

                await deleteWidget(client, widget, "DELETE /api/widgets/:id", created);
                expectNotFound(await client.request("GET", `/api/widgets/${widget.id}`), "GET /api/widgets/:id after DELETE");
                expectNotFound(await client.request("DELETE", `/api/widgets/${widget.id}`), "DELETE /api/widgets/:id twice");
            } finally {
                // Whatever failed above, leave nothing behind.
                for (const id of created) await client.request("DELETE", `/api/widgets/${id}`).catch(() => undefined);
            }
        },
    },
    {
        name: "GET /api/widgets/:id for an unknown id is 404",
        async run({ client }) {
            expectNotFound(await client.request("GET", `/api/widgets/${randomUUID()}`), "GET /api/widgets/:id (unknown)");
        },
    },
    {
        name: "DELETE /api/widgets/:id for an unknown id is 404",
        async run({ client }) {
            expectNotFound(await client.request("DELETE", `/api/widgets/${randomUUID()}`), "DELETE /api/widgets/:id (unknown)");
        },
    },
    {
        name: "GET / serves the HTML page",
        async run({ client }) {
            const response = await client.request("GET", "/");
            expectStatus(response, 200, "GET /");
            const type = String(response.headers["content-type"] ?? "").toLowerCase();
            expect(type.startsWith("text/html"), `GET /: expected content-type text/html, got ${show(type)}`);
            expect(/^\s*<!doctype html/i.test(response.text), `GET /: the body is not an HTML document (${preview(response.text)})`);
        },
    },
    {
        name: "an unmatched route is 404, whatever the method",
        async run({ client }) {
            expectNotFound(await client.request("GET", "/no-such-route"), "GET /no-such-route");
            expectNotFound(await client.request("PUT", "/api/widgets"), "PUT /api/widgets");
        },
    },
]);

// --- running -----------------------------------------------------------------

// A system error (ECONNREFUSED, ECONNRESET, a timeout ...) means the instance is not answering at all. Every
// remaining check would fail the same way, so the run stops there instead of printing the same error nine times.
const isConnectionError = (error) => !(error instanceof SmokeFailure) && typeof error?.code === "string";

/**
 * Runs every check against the instance behind `client`.
 *
 * @param {{ request: Function }} client  from createClient
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {Promise<{ ok: boolean, passed: number, total: number, results: { name: string, ok: boolean, detail?: string }[] }>}
 */
export async function runSmoke(client, { log = () => undefined } = {}) {
    const results = [];
    for (const check of CHECKS) {
        try {
            await check.run({ client });
            results.push({ name: check.name, ok: true });
            log(`  ok    ${check.name}`);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            results.push({ name: check.name, ok: false, detail });
            log(`  FAIL  ${check.name} — ${detail}`);
            if (isConnectionError(error)) {
                log("  the instance is not answering; the remaining checks were not run");
                break;
            }
        }
    }
    const passed = results.filter((result) => result.ok).length;
    return { ok: passed === CHECKS.length, passed, total: CHECKS.length, results };
}

/**
 * @param {string[]} argv
 * @returns {{ help: boolean, baseUrl?: string, timeoutMs: number }}
 */
export function parseArgs(argv) {
    const options = { help: false, baseUrl: undefined, timeoutMs: DEFAULT_TIMEOUT_MS };
    let index = 0;
    while (index < argv.length) {
        const arg = argv[index++];
        const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
        const flag = equals === -1 ? arg : arg.slice(0, equals);
        const inline = equals === -1 ? undefined : arg.slice(equals + 1);
        const value = () => {
            const given = inline ?? argv[index++];
            if (given === undefined) throw new UsageError(`${flag} needs a value`);
            return given;
        };
        if (flag === "--base-url") {
            options.baseUrl = value();
        } else if (flag === "--timeout") {
            const raw = value();
            if (!/^\d+$/.test(raw) || Number(raw) === 0) throw new UsageError(`--timeout must be a positive number of milliseconds, got ${show(raw)}`);
            options.timeoutMs = Number(raw);
        } else if (flag === "--help" || flag === "-h") {
            options.help = true;
        } else {
            throw new UsageError(`unknown option ${show(arg)}`);
        }
    }
    if (!options.help && options.baseUrl === undefined) throw new UsageError("--base-url is required");
    return options;
}

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
    let options;
    let client;
    try {
        options = parseArgs(argv);
        if (options.help) {
            log(USAGE);
            return 0;
        }
        client = createClient(options.baseUrl, { timeoutMs: options.timeoutMs });
    } catch (cause) {
        if (!(cause instanceof UsageError)) throw cause;
        error(`smoke: ${cause.message}`);
        error(USAGE);
        return 2;
    }

    try {
        log(`smoke: ${client.baseUrl}`);
        const summary = await runSmoke(client, { log });
        log(`smoke: ${summary.passed}/${summary.total} checks passed — ${summary.ok ? "PASSED" : "FAILED"}`);
        return summary.ok ? 0 : 1;
    } finally {
        client.close();
    }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = await main();
