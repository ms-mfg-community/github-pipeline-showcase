import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, createServer, type RequestListener } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import type { Express } from "express";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";

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
// The helper is deliberately repeated in app.test.ts, app.contract.qa.test.ts and both *.delta.qa.test.ts
// suites: the mutation runners copy each test file into a scratch directory on its own, so a shared helper
// module would not be there.
const endpoint =
    process.platform === "win32"
        ? `\\\\.\\pipe\\wp1-ui-${randomUUID().slice(0, 8)}`
        : join(tmpdir(), `wp1-ui-${randomUUID().slice(0, 8)}.sock`);

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

// Execute the shipped inline script, not a reimplementation of its functions. The
// small DOM double supports only the operations this single static page uses.
class PageElement {
    textContent = "";
    value = "";
    hidden = false;
    type = "";
    title = "";
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
    children: PageElement[] = [];

    constructor(readonly tagName: string) {}

    append(...elements: PageElement[]): void {
        this.children.push(...elements);
    }

    replaceChildren(...elements: PageElement[]): void {
        this.children = elements;
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    addEventListener(name: string, listener: (event: { preventDefault(): void }) => unknown): void {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }

    async emit(name: string): Promise<void> {
        await Promise.all((this.listeners.get(name) ?? []).map((listener) => listener({ preventDefault() {} })));
    }
}

type FetchOptions = { method?: string; headers?: Record<string, string>; body?: string };
type Fetcher = (path: string, options?: FetchOptions) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

function apiFetch(app: Express): Fetcher {
    return async (path, options = {}) => {
        const method = options.method ?? "GET";
        const agent = request(app);
        const call = method === "POST" ? agent.post(path) : method === "DELETE" ? agent.delete(path) : agent.get(path);
        for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
        if (options.body !== undefined) call.send(options.body);
        const response = await call;
        return { status: response.status, ok: response.status >= 200 && response.status < 300, json: async () => response.body };
    };
}

async function openPage(fetch: Fetcher) {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const elements = new Map<string, PageElement>();
    // Element ids, input defaults and hidden flags come from the real HTML artifact.
    for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
        const [, tag, attributes, id] = match;
        if (tag === undefined || attributes === undefined || id === undefined) throw new Error("Invalid HTML fixture match");
        const element = new PageElement(tag);
        element.value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] ?? "";
        element.hidden = /\bhidden\b/.test(attributes);
        elements.set(id, element);
    }
    const document = {
        getElementById: (id: string) => elements.get(id) ?? null,
        createElement: (tag: string) => new PageElement(tag),
    };
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(1);
    const script = scripts[0]?.[1];
    if (script === undefined) throw new Error("The shipped page has no inline script");
    const context = createContext({ document, fetch });
    await runInContext(script, context, { filename: "public/index.html", timeout: 1_000 });
    const element = (id: string) => {
        const found = elements.get(id);
        if (found === undefined) throw new Error(`The shipped page is missing #${id}`);
        return found;
    };
    return { element };
}

function newApp() {
    return createApp({
        config: { ...DEFAULTS, appVersion: "qa-1.2.3", gitCommit: "qa-commit", appEnv: "qa" },
        logger: createLogger("error", () => undefined),
    });
}

describe("QA — static page actually calls and renders the API", () => {
    it("renders version labels and actual stored widgets, with hostile-looking names kept as text", async () => {
        const app = newApp();
        const name = "<img src=x onerror=alert(1)>";
        const created = await request(app).post("/api/widgets").send({ name, quantity: 3 });
        const { element } = await openPage(apiFetch(app));

        expect(element("version").textContent).toBe("Version qa-1.2.3 · commit qa-commit · environment qa");
        expect(element("widgets").children).toHaveLength(1);
        const label = element("widgets").children[0]?.children[0];
        expect(label?.textContent).toBe(`${name} × 3`);
        expect(label?.children).toEqual([]);
        expect(label?.title).toContain(created.body.id);
        expect(label?.title).toContain(created.body.createdAt);
        expect(element("empty").hidden).toBe(true);
        expect(element("error").textContent).toBe("");
    });

    it("renders an empty-state message for an empty API list", async () => {
        const { element } = await openPage(apiFetch(newApp()));
        expect(element("widgets").children).toEqual([]);
        expect(element("empty").hidden).toBe(false);
    });

    it("submits numeric quantities, persists the widget, then refreshes the rendered list", async () => {
        const app = newApp();
        const { element } = await openPage(apiFetch(app));
        element("name").value = "  submitted gear  ";
        element("quantity").value = "0";
        await element("add").emit("submit");
        await vi.waitFor(() => expect(element("widgets").children[0]?.children[0]?.textContent).toBe("submitted gear × 0"));

        expect((await request(app).get("/api/widgets")).body.items).toEqual([
            expect.objectContaining({ name: "submitted gear", quantity: 0 }),
        ]);
        expect(element("name").value).toBe("");
        expect(element("empty").hidden).toBe(true);
    });

    it("deletes the selected widget on the server and refreshes the empty state", async () => {
        const app = newApp();
        const created = await request(app).post("/api/widgets").send({ name: "delete me", quantity: 1 });
        const { element } = await openPage(apiFetch(app));
        const remove = element("widgets").children[0]?.children[1];
        expect(remove?.attributes.get("aria-label")).toBe("Delete delete me");
        if (remove === undefined) throw new Error("Missing rendered delete button");
        await remove.emit("click");

        expect((await request(app).get(`/api/widgets/${created.body.id}`)).status).toBe(404);
        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [] });
        expect(element("widgets").children).toEqual([]);
        expect(element("empty").hidden).toBe(false);
    });

    it("surfaces validation details for a missing quantity without creating a widget or discarding input", async () => {
        const app = newApp();
        const { element } = await openPage(apiFetch(app));
        element("name").value = "unfinished";
        element("quantity").value = "";
        await element("add").emit("submit");
        await vi.waitFor(() => expect(element("error").textContent.length).toBeGreaterThan(0));

        expect((await request(app).get("/api/widgets")).body).toEqual({ items: [] });
        expect(element("name").value).toBe("unfinished");
    });

    it("shows a network failure instead of leaving an unhandled page promise", async () => {
        const { element } = await openPage(async () => { throw new Error("network unavailable"); });
        expect(element("error").textContent).toBe("network unavailable");
    });
});
