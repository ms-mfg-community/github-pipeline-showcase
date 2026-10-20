import { randomUUID } from "node:crypto";
import { Agent, createServer, type RequestListener } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants, deflateSync, gzipSync } from "node:zlib";
import type { Express } from "express";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const JSON_TYPE = "application/json; charset=utf-8";
const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const VALID = JSON.stringify({ name: "after", quantity: 0 });
const PADDING = " \t\u2003".repeat(24_000);
const LARGE_VALID = JSON.stringify({
    name: `${PADDING}${"x".repeat(64)}${PADDING}`,
    quantity: 0,
    id: { ignored: "client-input".repeat(24_000) },
    createdAt: ["client-createdAt".repeat(24_000)],
});
const CODECS = [
    { encoding: "gzip", compress: (text: string) => gzipSync(text) },
    { encoding: "deflate", compress: (text: string) => deflateSync(text) },
    // The compression ratio is not under test; use the fast encoder setting.
    { encoding: "br", compress: (text: string) => brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }) },
].map((codec) => ({
    ...codec,
    // Compressed once, at module load, rather than inside every test body.
    valid: codec.compress(VALID),
    large: codec.compress(LARGE_VALID),
}));

const makeApp = () => createApp({ config: DEFAULTS, logger: createLogger("error", () => undefined) });

// Ceilings that turn a hung server into a failure, not budgets for a healthy one. A request that inflates and validates
// a few hundred kilobytes takes tens of milliseconds on an idle machine and many seconds when every CPU is busy, which
// is what the 2 s and 5 s limits this file used to have could not survive.
const REQUEST_TIMEOUT = { response: 30_000, deadline: 45_000 };
vi.setConfig({ testTimeout: 60_000 });

// --- shared transport ---------------------------------------------------------------------------------
//
// supertest's request(app) starts and closes a new http.Server for every call, and superagent opens a new
// `Connection: close` TCP socket for every request, so this file used to make about 190 TCP connects. On
// Windows, libuv 1.51.0 (bundled with Node 24.15.0) passes an uninitialised OSVERSIONINFOW to RtlGetVersion
// on every TCP connect (uv__is_fast_loopback_fail_supported; fixed in libuv 1.53.0, PR #5107). When the
// stale stack bytes there happen to equal sizeof(OSVERSIONINFOEXW), RtlGetVersion writes 8 bytes past the
// buffer, corrupts the stack cookie and kills the worker ("Worker exited unexpectedly", exit code
// 0xC0000409). Making fewer connects only made that rarer, so this file opens none: its one server listens
// on a named pipe (Windows) or a Unix domain socket (elsewhere), and a pooled keep-alive agent sends every
// request there, whatever host and port the URL names. The HTTP on the wire is the same. A Node release
// that bundles libuv 1.53.0 or later does not need this.
//
// The helper is deliberately repeated in body-parser.delta.qa.test.ts: the mutation runners copy each
// test file into a scratch directory on its own, so a shared helper module would not be there.
const endpoint =
    process.platform === "win32"
        ? `\\\\.\\pipe\\wp1-compression-${randomUUID().slice(0, 8)}`
        : join(tmpdir(), `wp1-compression-${randomUUID().slice(0, 8)}.sock`);

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

// Superagent would otherwise JSON-serialize a Buffer. Send actual encoded wire bytes.
function encoded(app: Express, encoding: string, body: Buffer) {
    return request(app).post("/api/widgets")
        .set("Content-Type", "application/json")
        .set("Content-Encoding", encoding)
        .serialize((value: unknown) => value as string)
        .send(body)
        .timeout(REQUEST_TIMEOUT);
}

async function keepWidget(app: Express) {
    const response = await request(app).post("/api/widgets").send({ name: "keep", quantity: 1 });
    expect(response.status).toBe(201);
    return response.body;
}

describe("QA round 3 — compressed bodies obey the field contract after inflation", () => {
    it.each(CODECS)("accepts large valid $encoding and persists only generated fields", async ({ encoding, large }) => {
        const app = makeApp();
        expect(Buffer.byteLength(LARGE_VALID)).toBeGreaterThan(100 * 1024);
        expect(large.length).toBeLessThan(100 * 1024);

        const response = await encoded(app, encoding, large);

        expect(response.status).toBe(201);
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toEqual({
            id: expect.stringMatching(UUID_V4),
            name: "x".repeat(64),
            quantity: 0,
            createdAt: expect.any(String),
        });
        expect(new Date(response.body.createdAt).toISOString()).toBe(response.body.createdAt);
        expect((await request(app).get(`/api/widgets/${response.body.id}`)).body).toEqual(response.body);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [response.body] });
        expect((await request(app).delete(`/api/widgets/${response.body.id}`)).status).toBe(204);
        expect((await request(app).get(`/api/widgets/${response.body.id}`)).body).toEqual({ error: "not_found" });
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [] });
    });
});

const invalidStreams = CODECS.flatMap(({ encoding, valid }) => [
    { encoding, kind: "empty entity", bytes: Buffer.alloc(0), valid },
    { encoding, kind: "truncated stream", bytes: valid.subarray(0, Math.floor(valid.length / 2)), valid },
    { encoding, kind: "invalid stream header", bytes: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]), valid },
]);

describe("QA round 3 — unreadable streams reject without damaging accepted state", () => {
    it.each(invalidStreams)("$encoding $kind returns 400 and recovers on the same app", async ({ encoding, bytes, valid }) => {
        const app = makeApp();
        const keep = await keepWidget(app);
        // Repeating a failure must neither poison the parser nor remove accepted records.
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await encoded(app, encoding, bytes);
            expect(response.status).toBe(400);
            expect(response.headers["content-type"]).toBe(JSON_TYPE);
            expect(response.body).toEqual({ error: "invalid_payload", details: expect.any(Array) });
            expect(response.body.details.length).toBeGreaterThan(0);
            expect(response.body.details.every((detail: unknown) => typeof detail === "string")).toBe(true);
            expect((await request(app).get("/api/widgets")).body).toEqual({ items: [keep] });
            expect((await request(app).get(`/api/widgets/${keep.id}`)).body).toEqual(keep);
        }
        const next = await encoded(app, encoding, valid);
        expect(next.status).toBe(201);
        expect(next.body).toMatchObject({ name: "after", quantity: 0 });
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [keep, next.body] });
        expect((await request(app).get("/healthz")).body.status).toBe("ok");
    });

    const invalidDecodedBodies = CODECS.flatMap(({ encoding, compress }) => [
        { encoding, kind: "malformed decoded JSON", bytes: compress('{"name":"bad","quantity":1,') },
        { encoding, kind: "invalid decoded fields", bytes: compress(JSON.stringify({ name: "bad", quantity: -1 })) },
    ]);

    it.each(invalidDecodedBodies)("$encoding $kind retains the validation error and stored state", async ({ encoding, bytes }) => {
        const app = makeApp();
        const keep = await keepWidget(app);
        const response = await encoded(app, encoding, bytes);

        expect(response.status).toBe(400);
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toEqual({ error: "invalid_payload", details: expect.any(Array) });
        expect(response.body.details.length).toBeGreaterThan(0);
        expect(response.body.details.every((detail: unknown) => typeof detail === "string")).toBe(true);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [keep] });
        expect((await request(app).get(`/api/widgets/${keep.id}`)).body).toEqual(keep);
    });
});

describe("QA round 3 — parser-error classification does not take over sibling routes", () => {
    const badIds = ["%", "%E0%A4%A", "%FF"];
    const malformedPaths = badIds.flatMap((id) => [
        { method: "get" as const, id },
        { method: "delete" as const, id },
    ]);

    it.each(malformedPaths)("$method with undecodable id $id stays JSON 404", async ({ method, id }) => {
        const app = makeApp();
        const keep = await keepWidget(app);
        const response = await request(app)[method](`/api/widgets/${id}`);

        expect(response.status).toBe(404);
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toEqual({ error: "not_found" });
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [keep] });
        expect((await request(app).get(`/api/widgets/${keep.id}`)).body).toEqual(keep);
    });

    const siblings = [
        { method: "get" as const, path: "/healthz", status: 200 },
        { method: "get" as const, path: "/api/version", status: 200 },
        { method: "get" as const, path: "/api/widgets", status: 200 },
        { method: "get" as const, path: "/api/widgets/:id", status: 200 },
        { method: "delete" as const, path: "/api/widgets/:id", status: 204 },
        { method: "post" as const, path: "/missing", status: 404 },
        { method: "get" as const, path: "/", status: 200 },
    ];

    it.each(siblings)("$method $path ignores a body that falsely claims gzip", async ({ method, path, status }) => {
        const app = makeApp();
        const keep = await keepWidget(app);
        const response = await request(app)[method](path.replace(":id", String(keep.id)))
            .set("Content-Type", "application/json").set("Content-Encoding", "gzip")
            .send("{broken").timeout(REQUEST_TIMEOUT);

        expect(response.status).toBe(status);
        if (method === "delete") {
            expect(response.text).toBe("");
            expect((await request(app).get(`/api/widgets/${keep.id}`)).status).toBe(404);
            expect((await request(app).get("/api/widgets")).body).toEqual({ items: [] });
        } else {
            if (path === "/") {
                expect(response.headers["content-type"]).toMatch(/^text\/html/);
                expect(response.text).toContain("<title>Widget Showcase</title>");
            } else {
                expect(response.headers["content-type"]).toBe(JSON_TYPE);
                if (path === "/api/widgets/:id") expect(response.body).toEqual(keep);
                if (path === "/api/widgets") expect(response.body).toEqual({ items: [keep] });
                if (status === 404) expect(response.body).toEqual({ error: "not_found" });
            }
            expect((await request(app).get("/api/widgets")).body).toEqual({ items: [keep] });
        }
    });
});

it("QA round 3 — concurrent decoded and undecodable requests isolate their state", async () => {
    const app = makeApp();
    const keep = await keepWidget(app);
    const good = CODECS.map(({ encoding, large }) => encoded(app, encoding, large));
    const bad = CODECS.map(({ encoding }) => encoded(app, encoding, Buffer.from("not-compressed")));
    const [accepted, rejected] = await Promise.all([Promise.all(good), Promise.all(bad)]);

    expect(accepted.map((response) => response.status)).toEqual([201, 201, 201]);
    expect(rejected.map((response) => response.status)).toEqual([400, 400, 400]);
    for (const response of rejected) {
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toEqual({ error: "invalid_payload", details: expect.any(Array) });
        expect(response.body.details.length).toBeGreaterThan(0);
    }
    const expected = [keep, ...accepted.map((response) => response.body)];
    expect(new Set(expected.map((widget) => widget.id)).size).toBe(4);
    const listed = await request(app).get("/api/widgets");
    expect(listed.body.items).toHaveLength(4);
    expect(listed.body.items).toEqual(expect.arrayContaining(expected));
    for (const widget of expected) {
        expect((await request(app).get(`/api/widgets/${widget.id}`)).body).toEqual(widget);
    }
    expect((await request(app).get("/healthz")).body.status).toBe("ok");
});
