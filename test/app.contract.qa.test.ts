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

// --- shared transport ---------------------------------------------------------------------------------
//
// supertest's request(app) starts and closes a new http.Server for every call, and superagent opens a new
// `Connection: close` TCP socket for every request, so this file used to make a TCP connect per request.
// On Windows, libuv 1.51.0 (bundled with Node 24.15.0) passes an uninitialised OSVERSIONINFOW to
// RtlGetVersion on every TCP connect (uv__is_fast_loopback_fail_supported; fixed in libuv 1.53.0, PR #5107).
// When the stale stack bytes there happen to equal sizeof(OSVERSIONINFOEXW), RtlGetVersion writes 8 bytes
// past the buffer, corrupts the stack cookie and kills the worker ("Worker exited unexpectedly", exit code
// 0xC0000409). Making fewer connects only made that rarer, so this file opens none: its one server listens
// on a named pipe (Windows) or a Unix domain socket (elsewhere), and a pooled keep-alive agent sends every
// request there, whatever host and port the URL names. The HTTP on the wire is the same. A Node release that
// bundles libuv 1.53.0 or later does not need this.
//
// The helper is deliberately repeated in app.test.ts, ui.qa.test.ts and both *.delta.qa.test.ts suites: the
// mutation runners copy each test file into a scratch directory on its own, so a shared helper module would
// not be there.
const endpoint =
    process.platform === "win32"
        ? `\\\\.\\pipe\\wp1-contract-${randomUUID().slice(0, 8)}`
        : join(tmpdir(), `wp1-contract-${randomUUID().slice(0, 8)}.sock`);

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
        put: (path: string) => client.put(path).agent(pooled),
        patch: (path: string) => client.patch(path).agent(pooled),
        delete: (path: string) => client.delete(path).agent(pooled),
    };
}

describe("QA — the POST contract applies to the validated fields, not ignored input", () => {
    it("accepts a 1-character name after trimming even when the padding exceeds 10 KiB", async () => {
        const app = makeApp();
        const response = await request(app).post("/api/widgets").send({
            name: `${" ".repeat(6_000)}x${" ".repeat(6_000)}`,
            quantity: 0,
        });

        // §5.3 measures the name AFTER trim and specifies no raw-body-size restriction.
        expect(response.status).toBe(201);
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toMatchObject({ name: "x", quantity: 0 });
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [response.body] });
        expect((await request(app).get(`/api/widgets/${response.body.id}`)).body).toEqual(response.body);
    });

    it.each(["id", "createdAt"] as const)("ignores a large client-supplied %s instead of rejecting it", async (field) => {
        const app = makeApp();
        const supplied = "client-controlled-".repeat(700);
        const response = await request(app).post("/api/widgets").send({
            name: "gear",
            quantity: 1,
            [field]: supplied,
        });

        // §5.3 explicitly says client id/createdAt are ignored, not an error.
        expect(response.status).toBe(201);
        expect(response.body[field]).not.toBe(supplied);
        expect(response.body.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
        expect(new Date(response.body.createdAt).toISOString()).toBe(response.body.createdAt);
        expect(Object.keys(response.body).sort()).toEqual(["createdAt", "id", "name", "quantity"]);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [response.body] });
    });
});

describe("QA — repeated and concurrent operations preserve the HTTP/store contract", () => {
    it("stores every concurrent creation and removes an id exactly once without harming its siblings", async () => {
        const app = makeApp();
        const created = await Promise.all(Array.from({ length: 24 }, (_, index) =>
            request(app).post("/api/widgets").send({ name: `gear-${index}`, quantity: index }),
        ));
        expect(created.every((response) => response.status === 201)).toBe(true);
        const ids = created.map((response) => String(response.body.id));
        expect(new Set(ids).size).toBe(24);
        const victim = ids[0];
        expect(victim).toBeDefined();

        const deletes = await Promise.all(Array.from({ length: 8 }, () => request(app).delete(`/api/widgets/${victim}`)));
        expect(deletes.filter((response) => response.status === 204)).toHaveLength(1);
        for (const response of deletes.filter((result) => result.status !== 204)) {
            expect(response.status).toBe(404);
            expect(response.headers["content-type"]).toBe(JSON_TYPE);
            expect(response.body).toEqual({ error: "not_found" });
        }
        expect((await request(app).get(`/api/widgets/${victim}`)).body).toEqual({ error: "not_found" });
        const remaining = await request(app).get("/api/widgets");
        expect(remaining.body.items.map((widget: { id: string }) => widget.id).sort()).toEqual(ids.slice(1).sort());
        for (const response of created.slice(1)) {
            expect((await request(app).get(`/api/widgets/${response.body.id}`)).body).toEqual(response.body);
        }
    });

    it("recovers from a parser rejection without losing previously accepted state", async () => {
        const app = makeApp();
        const existing = await request(app).post("/api/widgets").send({ name: "keep", quantity: 1 });
        const rejected = await request(app).post("/api/widgets").set("Content-Type", "application/json").send("{broken");
        expect(rejected.status).toBe(400);
        expect(rejected.body).toEqual({ error: "invalid_payload", details: expect.any(Array) });
        expect(rejected.body.details.length).toBeGreaterThan(0);
        expect(rejected.body.details.every((detail: unknown) => typeof detail === "string")).toBe(true);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [existing.body] });
        expect((await request(app).get("/healthz")).body.status).toBe("ok");
        expect((await request(app).post("/api/widgets").send({ name: "next", quantity: 2 })).status).toBe(201);
    });

    it.each([
        ["post", "/missing"],
        ["put", "/api/widgets"],
        ["patch", "/api/widgets/some-id"],
        ["delete", "/healthz"],
    ] as const)("%s %s remains an unmatched JSON 404 even with malformed JSON", async (method, path) => {
        const response = await request(makeApp())[method](path).set("Content-Type", "application/json").send("{broken");
        expect(response.status).toBe(404);
        expect(response.headers["content-type"]).toBe(JSON_TYPE);
        expect(response.body).toEqual({ error: "not_found" });
    });
});
