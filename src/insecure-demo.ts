// ================================================================================================
//  INTENTIONALLY VULNERABLE CODE - DEMONSTRATION CONTENT ONLY
// ================================================================================================
//
// This file exists to give the code-scanning demo genuine findings to show. It contains two
// deliberate security vulnerabilities. They are the product here, not mistakes, and they are
// not candidates for a quick tidy-up:
//
//   1. Command injection  (CWE-78)   GET /demo/echo      builds a shell command from request input.
//   2. ReDoS              (CWE-1333) GET /demo/validate  runs a catastrophically backtracking
//                                                        regular expression over request input.
//
// NEVER ENABLE THESE ROUTES OUTSIDE THE DEMO, and never copy this code. Anyone who can reach
// them can run commands on the host (1) or pin a CPU core with a single request (2).
//
// How it is kept contained:
//   - src/app.ts mounts `demoRouter` at /demo only when ENABLE_INSECURE_DEMO is exactly "true"
//     (src/config.ts). The default is off, and while it is off /demo/* is an ordinary unmatched
//     route that answers 404 {"error":"not_found"}.
//   - scripts/deploy.mjs forces ENABLE_INSECURE_DEMO=false in every environment it deploys to.
//   - The module has no side effects when imported: it creates a router and registers routes on
//     it, and does nothing else.
//
// Why the code is shaped the way it is: CodeQL reports a vulnerability only when request input
// can be traced to it. So each flaw sits in an exported route handler, the handlers are
// registered on an exported Express router, and the request's own `query` is what reaches the
// dangerous call. Do not move the flaws behind a dead branch or out of the exports: the alert
// would silently disappear and the demo would have nothing to show.
//
// Every vulnerable line carries a "VULNERABLE:" comment naming its class.

import { exec } from "node:child_process";
import { Router, type Request, type Response } from "express";

// Words separated by at most one space, e.g. "blue widget".
//
// VULNERABLE: ReDoS (CWE-1333). `\w+` sits inside a group that is itself repeated with `+`, and the
// `\s?` between words is optional. A run of word characters can therefore be split between the
// repetitions in exponentially many ways, and a failing match tries them all.
const TITLE_PATTERN = /^(\w+\s?)+$/; // VULNERABLE: ReDoS (CWE-1333)

/** GET /demo - lists the demo routes. Safe: it touches no request input. */
export function indexHandler(_req: Request, res: Response): void {
    res.json({
        warning: "Intentionally vulnerable demo routes. Never enable ENABLE_INSECURE_DEMO outside the demo.",
        routes: ["GET /demo/echo?text=<text>", "GET /demo/validate?title=<title>"],
    });
}

/** GET /demo/echo?text=... - answers with whatever the shell echoes back. */
export function echoHandler(req: Request, res: Response): void {
    const text = req.query.text;
    if (typeof text !== "string") {
        res.status(400).json({ error: "invalid_query", details: ['query parameter "text" is required'] });
        return;
    }

    // VULNERABLE: command injection (CWE-78). The request's `text` is concatenated into a command line
    // that a shell then parses, so a value such as `hello; <another command>` runs that second command.
    // Passing arguments as an array to execFile, with no shell, is the fix.
    exec("echo " + text, (error, stdout) => { // VULNERABLE: command injection (CWE-78)
        if (error !== null) {
            res.status(500).json({ error: "command_failed" });
            return;
        }
        res.json({ output: stdout.trim() });
    });
}

/** GET /demo/validate?title=... - reports whether the title is words separated by single spaces. */
export function validateHandler(req: Request, res: Response): void {
    const title = req.query.title;
    if (typeof title !== "string") {
        res.status(400).json({ error: "invalid_query", details: ['query parameter "title" is required'] });
        return;
    }

    // VULNERABLE: ReDoS (CWE-1333). Request input is matched against TITLE_PATTERN above with no length
    // limit, so a long run of word characters ending in a character the pattern rejects keeps the
    // event loop busy for as long as the attacker likes. Node serves everything on that one thread.
    res.json({ valid: TITLE_PATTERN.test(title) }); // VULNERABLE: ReDoS (CWE-1333)
}

export const demoRouter = Router();
demoRouter.get("/", indexHandler);
demoRouter.get("/echo", echoHandler);
demoRouter.get("/validate", validateHandler);
