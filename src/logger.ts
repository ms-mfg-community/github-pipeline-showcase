// A deliberately small structured logger: one JSON object per line, filtered by LOG_LEVEL.
// warn/error go to stderr, debug/info to stdout, so `docker logs` and shells separate them.

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
    readonly level: LogLevel;
    isLevelEnabled(level: LogLevel): boolean;
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

/** Receives one finished log line (no trailing newline) and the level it was written at. */
export type LogWriter = (line: string, level: LogLevel) => void;

const writeToStandardStreams: LogWriter = (line, level) => {
    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
};

export function createLogger(level: LogLevel, write: LogWriter = writeToStandardStreams): Logger {
    const threshold = LOG_LEVELS.indexOf(level);
    const isLevelEnabled = (candidate: LogLevel): boolean => LOG_LEVELS.indexOf(candidate) >= threshold;

    const emit =
        (at: LogLevel) =>
        (message: string, fields: LogFields = {}): void => {
            if (!isLevelEnabled(at)) return;
            write(JSON.stringify({ time: new Date().toISOString(), level: at, msg: message, ...fields }), at);
        };

    return {
        level,
        isLevelEnabled,
        debug: emit("debug"),
        info: emit("info"),
        warn: emit("warn"),
        error: emit("error"),
    };
}
