import { randomUUID } from "node:crypto";
import { Agent, createServer, type RequestListener } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const makeApp = () => createApp({ config: DEFAULTS, logger: createLogger("error", () => undefined) });
const JSON_TYPE = "application/json; charset=utf-8";
const PADDING = " \t\u2003".repeat(24_000);
const IGNORED = "ignored-input-".repeat(24_000);
const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

// --- shared transport ---------------------------------------------------------------------------------
//
// supertest's request(app) starts and closes a new http.Server for every call, and superagent opens a new
// `Connection: close` TCP socket for every request. That breaks this file in two ways on Windows.
//
// 1. A server that answers 400 before it has read a ~336 KB body (the unsupported charset case) then
//    closes the socket with that body still unread. On a TCP socket that close is abortive (RST), and the
//    client can see `read ECONNRESET` instead of the 400 it was sent. A pooled keep-alive connection is
//    never closed after the response, so the server simply drains the body and the connection carries on.
// 2. Every request is a TCP connect, and on Windows libuv 1.51.0 (bundled with Node 24.15.0) passes an
//    uninitialised OSVERSIONINFOW to RtlGetVersion on every TCP connect (uv__is_fast_loopback_fail_supported;
//    fixed in libuv 1.53.0, PR #5107). When the stale stack bytes there happen to equal
//    sizeof(OSVERSIONINFOEXW), RtlGetVersion writes 8 bytes past the buffer, corrupts the stack cookie and
//    kills the worker ("Worker exited unexpectedly", exit code 0xC0000409). Making fewer connects only made
//    that rarer, so this file opens none.
//
// So its one server listens on a named pipe (Windows) or a Unix domain socket (elsewhere), and a pooled
// keep-alive agent sends every request there, whatever host and port the URL names. The HTTP on the wire is
// the same. A Node release that bundles libuv 1.53.0 or later no longer needs point 2. The helper is
// deliberately repeated in compression.delta.qa.test.ts: the mutation runners copy each test file into a
// scratch directory on its own, so a shared helper module would not be there.
const endpoint =
    process.platform === "win32"
        ? `\\\\.\\pipe\\wp1-body-parser-${randomUUID().slice(0, 8)}`
        : join(tmpdir(), `wp1-body-parser-${randomUUID().slice(0, 8)}.sock`);

class EndpointAgent extends Agent {
    // Node calls this to open each socket. The request's own host and port are ignored.
    createConnection(): Socket {
        return createConnection(endpoint);
    }
}

const pooled = new EndpointAgent({ keepAlive: true });
let mounted: RequestListener = (_req, res) => {
    res.statusCode = 500;
    res.end();
};
const server = createServer((req, res) => mounted(req, res));
// The default 5 s keep-alive timeout can close the pooled socket just as the next request is written.
server.keepAliveTimeout = 0;
// A plain URL string: supertest then leaves the server alone and the agent decides where requests go.
const client = supertest("http://localhost");

beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
            server.off("error", reject);
            resolve();
        });
    });
});

afterAll(async () => {
    pooled.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Stands in for supertest's request(app): `app` is served by this file's shared server over the pooled agent. */
function request(app: Express) {
    mounted = app;
    return {
        get: (path: string) => client.get(path).agent(pooled),
        post: (path: string) => client.post(path).agent(pooled),
        delete: (path: string) => client.delete(path).agent(pooled),
    };
}

describe("QA round 2 — large valid JSON still reaches field validation and the store", () => {
    const valid: Array<[string, Record<string, unknown>, string]> = [
        ["the lower trimmed-name boundary", { name: `${PADDING}x${PADDING}`, quantity: 0 }, "x"],
        ["the upper trimmed-name boundary", { name: `${PADDING}${"x".repeat(64)}${PADDING}`, quantity: 0 }, "x".repeat(64)],
        ["a large ignored object id", { name: "gear", quantity: 0, id: { nested: [IGNORED] } }, "gear"],
        ["a large ignored array createdAt", { name: "gear", quantity: 0, createdAt: [{ nested: IGNORED }] }, "gear"],
    ];

    it.each(valid)("accepts %s beyond the parser's default limit", async (_label, payload, name) => {
        expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(100 * 1024);
        const app = makeApp();
        const response = await request(app).post("/api/widgets").send(payload);

        expect(response.status).toBe(201);
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toEqual({
            id: expect.stringMatching(UUID_V4),
            name,
            quantity: 0,
            createdAt: expect.any(String),
        });
        expect(new Date(response.body.createdAt).toISOString()).toBe(response.body.createdAt);
        expect((await request(app).get(`/api/widgets/${response.body.id}`)).body).toEqual(response.body);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [response.body] });
        expect((await request(app).delete(`/api/widgets/${response.body.id}`)).status).toBe(204);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [] });
    });

    it("accepts JSON with a large whitespace envelope outside the fields", async () => {
        const app = makeApp();
        const envelope = " \t\r\n".repeat(32_000);
        const response = await request(app).post("/api/widgets").set("Content-Type", "application/json")
            .send(`${envelope}{"name":"gear","quantity":1}${envelope}`);

        expect(response.status).toBe(201);
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toMatchObject({ name: "gear", quantity: 1 });
        expect(response.body.id).toMatch(UUID_V4);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [response.body] });
    });
});

describe("QA round 2 — invalid fields in large bodies still reject without changing stored state", () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
        ["missing name", { quantity: 1 }],
        ["empty name after trimming", { name: PADDING, quantity: 1 }],
        ["65-character name after trimming", { name: `${PADDING}${"x".repeat(65)}${PADDING}`, quantity: 1 }],
        ["missing quantity", { name: "gear" }],
        ["negative quantity", { name: "gear", quantity: -1 }],
        ["fractional quantity", { name: "gear", quantity: 0.5 }],
    ];

    it.each(invalid)("returns 400 invalid_payload for %s", async (_label, fields) => {
        const app = makeApp();
        const keep = await request(app).post("/api/widgets").send({ name: "keep", quantity: 1 });
        expect(keep.status).toBe(201);
        const response = await request(app).post("/api/widgets").send({ ...fields, id: IGNORED, createdAt: [IGNORED] });

        expect(response.status).toBe(400);
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toEqual({ error: "invalid_payload", details: expect.any(Array) });
        expect(response.body.details.length).toBeGreaterThan(0);
        expect(response.body.details.every((detail: unknown) => typeof detail === "string")).toBe(true);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [keep.body] });
        expect((await request(app).get(`/api/widgets/${keep.body.id}`)).body).toEqual(keep.body);
        expect((await request(app).post("/api/widgets").send({ name: "next", quantity: 2 })).status).toBe(201);
    });
});

describe("QA round 2 — large parser errors still map to the specified HTTP error", () => {
    it.each([
        ["malformed JSON", "application/json", `{"name":"gear","quantity":1,"id":"${IGNORED}"`],
        ["an unsupported charset", "application/json; charset=iso-8859-1", JSON.stringify({ name: "gear", quantity: 1, id: IGNORED })],
    ])("rejects %s and remains usable", async (_label, contentType, body) => {
        const app = makeApp();
        const keep = await request(app).post("/api/widgets").send({ name: "keep", quantity: 1 });
        expect(keep.status).toBe(201);
        expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);
        const response = await request(app).post("/api/widgets").set("Content-Type", contentType).send(body);

        expect(response.status).toBe(400);
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toEqual({ error: "invalid_payload", details: expect.any(Array) });
        expect(response.body.details.length).toBeGreaterThan(0);
        expect(response.body.details.every((detail: unknown) => typeof detail === "string")).toBe(true);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [keep.body] });
        const next = await request(app).post("/api/widgets").send({ name: `${PADDING}next${PADDING}`, quantity: 2 });
        expect(next.status).toBe(201);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [keep.body, next.body] });
        expect((await request(app).get("/healthz")).body.status).toBe("ok");
    });
});
