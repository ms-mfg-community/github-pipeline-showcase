// The Express application — SPEC.md §5.3. It never calls listen(); server.ts does.
//
// createApp() builds an isolated instance with its own widget store, so tests never share
// state. `app` is the instance the real process serves, built from the real environment.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Express } from "express";
import morgan from "morgan";
import { config as processConfig, type Config } from "./config.js";
import { demoRouter } from "./insecure-demo.js";
import { createLogger, type Logger } from "./logger.js";
import { WidgetStore, validateWidgetInput } from "./widgets.js";

export interface AppDependencies {
    config?: Config;
    logger?: Logger;
    store?: WidgetStore;
}

// public/ is a sibling of both src/ and dist/, so this path resolves identically from the
// TypeScript sources (vitest) and from the compiled output the container runs.
const INDEX_HTML_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));

const NOT_FOUND = { error: "not_found" } as const;

type BodyParserError = Error & { status: number; type?: unknown };

// body-parser hands bad input to the error handler as an http-errors error: a 4xx `status` and
// `expose: true`, plus a string `type` for the failures it names itself (entity.parse.failed,
// charset.unsupported ...). It does not name every failure. A body that will not decompress arrives as
// the decompressor's own error, given the same 4xx status but no `type` (code Z_DATA_ERROR for a corrupt
// gzip or deflate stream, for one). So the 4xx status is what marks a request as the client's fault;
// `type` is only used to word the message.
const isBodyParserError = (err: unknown): err is BodyParserError =>
    err instanceof Error &&
    "status" in err &&
    typeof err.status === "number" &&
    err.status >= 400 &&
    err.status < 500;

const describeBodyError = (type: unknown): string => {
    switch (type) {
        case "entity.parse.failed":
            return "request body is not valid JSON";
        default:
            return "request body could not be read";
    }
};

export function createApp({
    config = processConfig,
    logger = createLogger(config.logLevel),
    store = new WidgetStore(),
}: AppDependencies = {}): Express {
    // The page is read once and served from memory: no per-request file access, and no
    // dependence on the working directory.
    const indexHtml = readFileSync(INDEX_HTML_PATH, "utf8");

    const app = express();
    app.disable("x-powered-by");

    // Every request, including 404s, passes through the access log. Lines go through the
    // structured logger so each one is a single JSON event whatever the request contained.
    app.use(morgan("combined", { stream: { write: (line) => logger.info(line.trimEnd(), { source: "access" }) } }));

    app.get("/", (_req, res) => {
        res.type("html").send(indexHtml);
    });

    app.get("/healthz", (_req, res) => {
        res.json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
    });

    app.get("/api/version", (_req, res) => {
        res.json({ version: config.appVersion, commit: config.gitCommit, environment: config.appEnv });
    });

    app.get("/api/widgets", (_req, res) => {
        res.json({ items: store.list() });
    });

    app.get("/api/widgets/:id", (req, res) => {
        const widget = store.get(req.params.id);
        if (widget === undefined) {
            res.status(404).json(NOT_FOUND);
            return;
        }
        res.json(widget);
    });

    // The JSON parser is mounted on this route only, so a body on any other route is never read.
    //
    // `limit: Infinity` is deliberate. §5.3 judges a POST by its fields alone: the name is measured
    // after trimming and a client-supplied id or createdAt is ignored, so the size of the raw body says
    // nothing about whether a request is valid. Any cap — body-parser's 100 KiB default included, which
    // is what applies when `limit` is left out — would answer a contract-valid request with a 400 before
    // validateWidgetInput ever saw it. Bounding request size is hardening this spec does not ask for
    // (§4.2); if it is wanted, the spec has to name the threshold and the status code.
    app.post("/api/widgets", express.json({ limit: Infinity }), (req, res) => {
        // Express 5 leaves req.body undefined when nothing was parsed; validation handles that.
        const result = validateWidgetInput(req.body);
        if (!result.ok) {
            res.status(400).json({ error: "invalid_payload", details: result.details });
            return;
        }
        res.status(201).json(store.create(result.value));
    });

    app.delete("/api/widgets/:id", (req, res) => {
        if (!store.delete(req.params.id)) {
            res.status(404).json(NOT_FOUND);
            return;
        }
        res.status(204).end();
    });

    // The deliberately vulnerable demo routes (insecure-demo.ts). Mounted only when ENABLE_INSECURE_DEMO is
    // exactly "true"; otherwise /demo/* is an ordinary unmatched route and falls through to the 404 below.
    if (config.enableInsecureDemo) {
        app.use("/demo", demoRouter);
    }

    // Anything above that did not respond is an unmatched route, whatever the method.
    app.use((_req, res) => {
        res.status(404).json(NOT_FOUND);
    });

    const handleError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
        // Once the response has started it cannot be rewritten; Express' default handler closes it.
        if (res.headersSent) {
            next(err);
            return;
        }
        if (err instanceof URIError) {
            // A path that cannot be percent-decoded cannot name a widget. Tested before the 4xx check
            // below because the router gives this error a 400 status, which would pass for a bad body.
            res.status(404).json(NOT_FOUND);
        } else if (isBodyParserError(err)) {
            res.status(400).json({ error: "invalid_payload", details: [describeBodyError(err.type)] });
        } else {
            logger.error("unhandled error", { message: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: "internal_error" });
        }
    };
    app.use(handleError);

    return app;
}

/** The application for the running process. server.ts listens on it. */
export const app = createApp();
