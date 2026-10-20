// Environment parsing — SPEC.md §5.2.
//
// Contract: an unset variable silently takes its default; a variable that is set but
// invalid takes its default AND produces exactly one warning. Nothing here throws, so bad
// configuration can never stop the process from starting.

import { LOG_LEVELS, createLogger, type LogLevel } from "./logger.js";

export interface Config {
    /** Listen port. 0 asks the OS for a free port. */
    port: number;
    /** Environment label surfaced by /api/version. */
    appEnv: string;
    /** Version label surfaced by /api/version. */
    appVersion: string;
    /** Commit SHA label surfaced by /api/version. */
    gitCommit: string;
    logLevel: LogLevel;
    /** True only when ENABLE_INSECURE_DEMO is exactly "true" (WP4 gates demo routes on it). */
    enableInsecureDemo: boolean;
}

export const DEFAULTS: Readonly<Config> = {
    port: 3000,
    appEnv: "local",
    appVersion: "0.0.0-dev",
    gitCommit: "unknown",
    logLevel: "info",
    enableInsecureDemo: false,
};

export type Warn = (message: string) => void;

const MAX_PORT = 65535;

type Parser<T> = (raw: string) => T | undefined;

const parsePort: Parser<number> = (raw) => {
    if (!/^\d+$/.test(raw)) return undefined;
    const port = Number(raw);
    return port <= MAX_PORT ? port : undefined;
};

// Labels are free text; the only rule is that they are not blank.
const parseLabel: Parser<string> = (raw) => (raw.trim() === "" ? undefined : raw.trim());

const parseLogLevel: Parser<LogLevel> = (raw) => LOG_LEVELS.find((level) => level === raw);

// Exact match on purpose: the insecure demo routes must never be switched on by a typo or a
// loosely-truthy value such as "1", "yes" or "TRUE".
const parseFlag: Parser<boolean> = (raw) => (raw === "true" ? true : raw === "false" ? false : undefined);

const warnToStderr: Warn = (message) => createLogger("warn").warn(message);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, warn: Warn = warnToStderr): Config {
    const read = <T>(name: string, fallback: T, parse: Parser<T>, expected: string): T => {
        const raw = env[name];
        if (raw === undefined) return fallback;
        const parsed = parse(raw);
        if (parsed === undefined) {
            warn(`Ignoring invalid ${name}=${JSON.stringify(raw)} (expected ${expected}); using default ${JSON.stringify(fallback)}`);
            return fallback;
        }
        return parsed;
    };

    return {
        port: read("PORT", DEFAULTS.port, parsePort, `an integer from 0 to ${MAX_PORT}`),
        appEnv: read("APP_ENV", DEFAULTS.appEnv, parseLabel, "a non-blank string"),
        appVersion: read("APP_VERSION", DEFAULTS.appVersion, parseLabel, "a non-blank string"),
        gitCommit: read("GIT_COMMIT", DEFAULTS.gitCommit, parseLabel, "a non-blank string"),
        logLevel: read("LOG_LEVEL", DEFAULTS.logLevel, parseLogLevel, LOG_LEVELS.join(", ")),
        enableInsecureDemo: read("ENABLE_INSECURE_DEMO", DEFAULTS.enableInsecureDemo, parseFlag, '"true" or "false"'),
    };
}

/** The process-wide configuration, read once from the real environment at first import. */
export const config: Config = loadConfig();
