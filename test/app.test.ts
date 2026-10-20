import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Express } from "express";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type AppDependencies } from "../src/app.js";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { WidgetStore } from "../src/widgets.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const JSON_CONTENT_TYPE = /^application\/json; charset=utf-8$/;
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

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
// The server also notes every response it starts, and a call resolves only once the server has finished with
// that response (`res` has emitted 'close'). Nothing orders the server's own 'finish' handlers ahead of the
// client reading the last byte, and morgan writes its access-log line from one of those handlers. Over this
// transport the client does win that race: without the wait, the access-log test below counted one line short.
//
// The helper is deliberately repeated in app.contract.qa.test.ts, ui.qa.test.ts and both *.delta.qa.test.ts
// suites: the mutation runners copy each test file into a scratch directory on its own, so a shared helper
// module would not be there.
const endpoint =
    process.platform === "win32"
        ? `\\\\.\\pipe\\wp1-app-${randomUUID().slice(0, 8)}`
        : join(tmpdir(), `wp1-app-${randomUUID().slice(0, 8)}.sock`);

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
// One promise per response the server has started and not yet finished with.
const unfinished = new Set<Promise<void>>();
const server = createServer((req, res) => {
    const finished = new Promise<void>((resolve) => res.once("close", resolve));
    unfinished.add(finished);
    void finished.then(() => unfinished.delete(finished));
    mounted(req, res);
});
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

/** Makes a request resolve only after the server has finished with every response it had started. */
function afterServer(test: supertest.Test): supertest.Test {
    const end = test.end.bind(test);
    test.end = (callback) => {
        end((error, response) => void Promise.all(unfinished).then(() => callback?.(error, response)));
        return test;
    };
    return test;
}

type Verb = "get" | "post" | "put" | "patch" | "delete" | "options";

/** Stands in for supertest's request(app): `app` is served by this file's shared server over the pooled agent. */
function request(app: Express) {
    mounted = app;
    const verb = (method: Verb) => (path: string) => afterServer(client[method](path).agent(pooled));
    return {
        get: verb("get"),
        post: verb("post"),
        put: verb("put"),
        patch: verb("patch"),
        delete: verb("delete"),
        options: verb("options"),
    };
}

const silent = createLogger("error", () => undefined);

/** A fresh app with its own empty widget store and a silent logger. */
const newApp = (deps: AppDependencies = {}): Express => createApp({ logger: silent, ...deps });

async function createWidget(app: Express, payload: object = { name: "gear", quantity: 3 }) {
    const res = await request(app).post("/api/widgets").send(payload);
    expect(res.status).toBe(201);
    return res.body as { id: string; name: string; quantity: number; createdAt: string };
}

describe("GET /healthz", () => {
    it("returns 200 with status ok and a numeric uptimeSeconds", async () => {
        const res = await request(newApp()).get("/healthz");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual({ status: "ok", uptimeSeconds: expect.any(Number) });
        expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
});

describe("GET /api/version", () => {
    it("returns 200 with version, commit and environment taken from the configuration", async () => {
        const app = newApp({ config: { ...DEFAULTS, appVersion: "1.2.3", gitCommit: "abc1234", appEnv: "staging" } });
        const res = await request(app).get("/api/version");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual({ version: "1.2.3", commit: "abc1234", environment: "staging" });
    });

    it("reports the documented defaults when nothing is configured", async () => {
        const res = await request(newApp({ config: DEFAULTS })).get("/api/version");

        expect(res.body).toEqual({ version: "0.0.0-dev", commit: "unknown", environment: "local" });
    });
});

describe("GET /api/widgets", () => {
    it("returns 200 with an empty items array when there are no widgets", async () => {
        const res = await request(newApp()).get("/api/widgets");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual({ items: [] });
    });

    it("returns every widget, oldest first", async () => {
        const app = newApp();
        const first = await createWidget(app, { name: "first", quantity: 1 });
        const second = await createWidget(app, { name: "second", quantity: 2 });

        const res = await request(app).get("/api/widgets");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ items: [first, second] });
    });
});

describe("GET /api/widgets/:id", () => {
    it("returns 200 with the widget", async () => {
        const app = newApp();
        const created = await createWidget(app);

        const res = await request(app).get(`/api/widgets/${created.id}`);

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual(created);
    });

    it.each([
        ["an unknown UUID", MISSING_ID],
        ["something that is not a UUID", "nope"],
        ["an id that cannot be percent-decoded", "%E0%A4%A"],
    ])("returns 404 not_found for %s", async (_label, id) => {
        const res = await request(newApp()).get(`/api/widgets/${id}`);

        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual({ error: "not_found" });
    });
});

describe("POST /api/widgets", () => {
    it("returns 201 with the created widget: server-generated UUID v4 id and ISO-8601 UTC createdAt", async () => {
        const before = Date.now();
        const res = await request(newApp()).post("/api/widgets").send({ name: "gear", quantity: 3 });

        expect(res.status).toBe(201);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual({
            id: expect.stringMatching(UUID_V4),
            name: "gear",
            quantity: 3,
            createdAt: expect.stringMatching(ISO_UTC),
        });
        expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
        expect(Date.parse(res.body.createdAt)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(res.body.createdAt)).toBeLessThanOrEqual(Date.now());
    });

    it("stores the widget, so it can be fetched and listed afterwards", async () => {
        const app = newApp();
        const created = await createWidget(app);

        expect((await request(app).get(`/api/widgets/${created.id}`)).body).toEqual(created);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [created] });
    });

    it("ignores a client-supplied id and createdAt rather than rejecting them", async () => {
        const res = await request(newApp())
            .post("/api/widgets")
            .send({ id: "client-chosen", createdAt: "1999-01-01T00:00:00.000Z", name: "gear", quantity: 3 });

        expect(res.status).toBe(201);
        expect(res.body.id).toMatch(UUID_V4);
        expect(res.body.id).not.toBe("client-chosen");
        expect(res.body.createdAt).not.toBe("1999-01-01T00:00:00.000Z");
        expect(Object.keys(res.body).sort()).toEqual(["createdAt", "id", "name", "quantity"]);
    });

    it("accepts the boundaries: 1-character and 64-character names, quantity 0", async () => {
        const app = newApp();
        expect((await request(app).post("/api/widgets").send({ name: "x", quantity: 0 })).status).toBe(201);
        expect((await request(app).post("/api/widgets").send({ name: "x".repeat(64), quantity: 1 })).status).toBe(201);
    });

    it("trims the name before storing it, and measures the 64-character limit after trimming", async () => {
        const app = newApp();
        const padded = await request(app).post("/api/widgets").send({ name: `  ${"x".repeat(64)}  `, quantity: 1 });
        const spaced = await request(app).post("/api/widgets").send({ name: "  spaced  ", quantity: 1 });

        expect(padded.status).toBe(201);
        expect(padded.body.name).toBe("x".repeat(64));
        expect(spaced.body.name).toBe("spaced");
    });

    it("gives every widget its own id", async () => {
        const app = newApp();
        const ids = new Set([(await createWidget(app)).id, (await createWidget(app)).id, (await createWidget(app)).id]);
        expect(ids.size).toBe(3);
    });
});

describe("POST /api/widgets — validation failures return 400 invalid_payload with details", () => {
    const invalid: Array<[label: string, payload: object]> = [
        ["a missing name", { quantity: 1 }],
        ["an empty name", { name: "", quantity: 1 }],
        ["a whitespace-only name", { name: "   \t ", quantity: 1 }],
        ["a name longer than 64 characters", { name: "x".repeat(65), quantity: 1 }],
        ["a name longer than 64 characters once padding is trimmed", { name: ` ${"x".repeat(65)} `, quantity: 1 }],
        ["a non-string name", { name: 123, quantity: 1 }],
        ["a null name", { name: null, quantity: 1 }],
        ["a missing quantity", { name: "gear" }],
        ["a negative quantity", { name: "gear", quantity: -1 }],
        ["a non-integer quantity", { name: "gear", quantity: 1.5 }],
        ["a quantity sent as a string", { name: "gear", quantity: "5" }],
        ["a null quantity", { name: "gear", quantity: null }],
        ["an empty object", {}],
        ["both fields invalid", { name: "", quantity: -1 }],
        ["a JSON array", []],
    ];

    it.each(invalid)("%s", async (_label, payload) => {
        const app = newApp();
        const res = await request(app).post("/api/widgets").send(payload);

        expect(res.status).toBe(400);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body.error).toBe("invalid_payload");
        expect(Array.isArray(res.body.details)).toBe(true);
        expect(res.body.details.length).toBeGreaterThan(0);
        expect(res.body.details.every((detail: unknown) => typeof detail === "string")).toBe(true);
        // A rejected request must not leave a widget behind.
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [] });
    });

    it.each([
        ["malformed JSON", "application/json", "{not json"],
        ["a JSON string instead of an object", "application/json", '"gear"'],
        ["the JSON literal null", "application/json", "null"],
        ["an empty body", "application/json", ""],
        ["a body that is not JSON at all", "text/plain", "name=gear&quantity=3"],
        ["a form-encoded body", "application/x-www-form-urlencoded", "name=gear&quantity=3"],
    ])("rejects %s", async (_label, contentType, body) => {
        const res = await request(newApp()).post("/api/widgets").set("Content-Type", contentType).send(body);

        expect(res.status).toBe(400);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body.error).toBe("invalid_payload");
        expect(res.body.details.length).toBeGreaterThan(0);
    });

    it("rejects a request with no body and no content type", async () => {
        const res = await request(newApp()).post("/api/widgets");

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_payload");
        expect(res.body.details.length).toBeGreaterThan(0);
    });

});

// A request may declare Content-Encoding gzip, deflate or br, and the body parser inflates it before
// parsing. When the bytes are not what the header claims, the decompressor's own error comes back with a
// 4xx status but — unlike a JSON syntax error — no string `type`. It is still the client's mistake, so it
// is answered 400 invalid_payload (§5.3) and is not an unhandled server error.
describe("POST /api/widgets — a body that cannot be decompressed is the client's error, not the server's", () => {
    const PAYLOAD = JSON.stringify({ name: "gear", quantity: 3 });
    const GZIPPED = gzipSync(PAYLOAD);
    // superagent JSON-encodes any non-string body sent as application/json; this sends the bytes untouched.
    const asIs = (body: unknown) => body as string;

    const undecodable: Array<[label: string, encoding: string, body: string | Buffer]> = [
        ["JSON text declared as gzip", "gzip", PAYLOAD],
        ["JSON text declared as deflate", "deflate", PAYLOAD],
        ["JSON text declared as br", "br", PAYLOAD],
        ["a gzip stream that stops part-way", "gzip", GZIPPED.subarray(0, Math.floor(GZIPPED.length / 2))],
    ];

    it.each(undecodable)("%s is 400 invalid_payload and is not logged as a server error", async (_label, encoding, body) => {
        const logged: string[] = [];
        const app = createApp({ logger: createLogger("error", (line) => logged.push(line)) });

        const res = await request(app)
            .post("/api/widgets")
            .set("Content-Type", "application/json")
            .set("Content-Encoding", encoding)
            .serialize(asIs)
            .send(body);

        expect(res.status).toBe(400);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body.error).toBe("invalid_payload");
        expect(Array.isArray(res.body.details)).toBe(true);
        expect(res.body.details.length).toBeGreaterThan(0);
        expect(res.body.details.every((detail: unknown) => typeof detail === "string")).toBe(true);
        // The client's mistake is not a server fault: nothing reaches the error log, and nothing is stored.
        expect(logged).toEqual([]);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [] });
    });

    it("still accepts a body that really is gzip-compressed", async () => {
        const res = await request(newApp())
            .post("/api/widgets")
            .set("Content-Type", "application/json")
            .set("Content-Encoding", "gzip")
            .serialize(asIs)
            .send(GZIPPED);

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: "gear", quantity: 3 });
    });
});

// §5.3 judges a POST by the fields it carries: the name is measured after trimming, a client-supplied
// id or createdAt is ignored, and no limit on the raw body is named. So none of these requests may be
// refused for its size. The payloads are about 2 MiB, well past any cap a parser would plausibly set,
// including body-parser's 100 KiB default — which is what quietly applies if an explicit `limit` is
// deleted rather than lifted.
describe("POST /api/widgets — validity is decided by the fields, never by the size of the body", () => {
    const WHITESPACE = " ".repeat(1024 * 1024);
    const FILLER = "client-controlled-".repeat(100_000);

    it("accepts a name that is valid once trimmed, however much whitespace surrounds it", async () => {
        const app = newApp();
        const res = await request(app).post("/api/widgets").send({ name: `${WHITESPACE}x${WHITESPACE}`, quantity: 0 });

        expect(res.status).toBe(201);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual({
            id: expect.stringMatching(UUID_V4),
            name: "x",
            quantity: 0,
            createdAt: expect.stringMatching(ISO_UTC),
        });
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [res.body] });
    });

    it.each(["id", "createdAt"] as const)("ignores a very large client-supplied %s instead of rejecting it", async (field) => {
        const res = await request(newApp()).post("/api/widgets").send({ name: "gear", quantity: 3, [field]: FILLER });

        expect(res.status).toBe(201);
        expect(res.body.id).toMatch(UUID_V4);
        expect(res.body.createdAt).toMatch(ISO_UTC);
        expect(Object.keys(res.body).sort()).toEqual(["createdAt", "id", "name", "quantity"]);
    });

    it("still rejects a name over 64 characters by the validation rule, however large the body", async () => {
        const app = newApp();
        const res = await request(app).post("/api/widgets").send({ name: "x".repeat(1024 * 1024), quantity: 1 });

        expect(res.status).toBe(400);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body.error).toBe("invalid_payload");
        expect(res.body.details.length).toBeGreaterThan(0);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [] });
    });
});

describe("DELETE /api/widgets/:id", () => {
    it("returns 204 with an empty body and removes the widget", async () => {
        const app = newApp();
        const created = await createWidget(app);

        const res = await request(app).delete(`/api/widgets/${created.id}`);

        expect(res.status).toBe(204);
        expect(res.text).toBe("");
        expect(res.headers["content-type"]).toBeUndefined();
        expect((await request(app).get(`/api/widgets/${created.id}`)).status).toBe(404);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [] });
    });

    it("removes only the widget it was asked to", async () => {
        const app = newApp();
        const keep = await createWidget(app, { name: "keep", quantity: 1 });
        const drop = await createWidget(app, { name: "drop", quantity: 1 });

        await request(app).delete(`/api/widgets/${drop.id}`);

        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [keep] });
    });

    it("returns 404 not_found for an unknown id", async () => {
        const res = await request(newApp()).delete(`/api/widgets/${MISSING_ID}`);

        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual({ error: "not_found" });
    });

    it("returns 404 not_found when the widget was already deleted", async () => {
        const app = newApp();
        const created = await createWidget(app);
        await request(app).delete(`/api/widgets/${created.id}`);

        const res = await request(app).delete(`/api/widgets/${created.id}`);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "not_found" });
    });
});

describe("GET /", () => {
    it("returns 200 with public/index.html as text/html", async () => {
        const expected = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

        const res = await request(newApp()).get("/");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/^text\/html/);
        expect(res.text).toBe(expected);
    });

    it("is a page that calls the two API endpoints it renders", async () => {
        const res = await request(newApp()).get("/");

        expect(res.text).toContain("/api/version");
        expect(res.text).toContain("/api/widgets");
    });
});

describe("any unmatched route returns 404 not_found", () => {
    type Method = "get" | "post" | "put" | "patch" | "delete" | "options";
    const unmatched: Array<[Method, string]> = [
        ["get", "/nope"],
        ["get", "/api"],
        ["get", "/api/unknown"],
        ["get", "/index.html"],
        ["get", "/api/widgets/a/b"],
        ["post", "/nope"],
        ["post", "/healthz"],
        ["post", "/api/version"],
        ["put", "/api/widgets/abc"],
        ["patch", "/api/widgets"],
        ["delete", "/api/widgets"],
        ["delete", "/"],
        ["options", "/api/widgets"],
    ];

    it.each(unmatched)("%s %s", async (method, path) => {
        const res = await request(newApp())[method](path);

        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual({ error: "not_found" });
    });
});

describe("failures the contract does not name", () => {
    class ExplodingStore extends WidgetStore {
        override list(): never {
            throw new Error("secret internal detail");
        }
    }

    it("answers 500 internal_error without leaking the cause, and logs it", async () => {
        const logged: string[] = [];
        const logger = createLogger("error", (line) => logged.push(line));

        const res = await request(createApp({ logger, store: new ExplodingStore() })).get("/api/widgets");

        expect(res.status).toBe(500);
        expect(res.headers["content-type"]).toMatch(JSON_CONTENT_TYPE);
        expect(res.body).toEqual({ error: "internal_error" });
        expect(res.text).not.toContain("secret internal detail");
        expect(logged.join("\n")).toContain("secret internal detail");
    });

    it("keeps serving after an internal error", async () => {
        const app = newApp({ store: new ExplodingStore() });
        await request(app).get("/api/widgets");

        expect((await request(app).get("/healthz")).status).toBe(200);
    });
});

describe("app instances", () => {
    it("are isolated: each createApp() has its own widget store", async () => {
        const a = newApp();
        const b = newApp();
        await createWidget(a);

        expect((await request(a).get("/api/widgets")).body.items).toHaveLength(1);
        expect((await request(b).get("/api/widgets")).body).toEqual({ items: [] });
    });

    it("write every request, including 404s, to the access log as one JSON event each", async () => {
        const lines: string[] = [];
        const app = createApp({ logger: createLogger("info", (line) => lines.push(line)) });

        await request(app).get("/healthz").set("User-Agent", "showcase-test-agent");
        await request(app).get("/nope");

        const events = lines.map((line) => JSON.parse(line));
        const access = events.filter((event) => event.source === "access");
        expect(access).toHaveLength(2);
        expect(access[0].msg).toContain("GET /healthz HTTP/1.1");
        expect(access[0].msg).toContain("showcase-test-agent");
        expect(access[1].msg).toContain("GET /nope HTTP/1.1");
        expect(access[1].msg).toContain(" 404 ");
    });
});

describe("the shared test transport", () => {
    it("holds each request until the server has finished with its response, so an access-log line is never late", async () => {
        const lines: string[] = [];
        const handle: RequestListener = createApp({ logger: createLogger("info", (line) => lines.push(line)) });
        // Here the server finishes every response 100 ms after the client has read it, an order Node does not rule out.
        const lateFinish = ((req: IncomingMessage, res: ServerResponse) => {
            const emit = res.emit.bind(res);
            res.emit = (event: string | symbol, ...args: unknown[]) => {
                if (event !== "finish" && event !== "close") return emit(event, ...args);
                setTimeout(() => emit(event, ...args), 100);
                return true;
            };
            handle(req, res);
        }) as unknown as Express;

        await request(lateFinish).get("/healthz");

        const access = lines.map((line) => JSON.parse(line)).filter((event) => event.source === "access");
        expect(access).toHaveLength(1);
    });
});
