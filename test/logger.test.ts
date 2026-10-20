import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_LEVELS, createLogger, type LogLevel } from "../src/logger.js";

function capture(level: LogLevel) {
    const written: Array<{ line: string; level: LogLevel }> = [];
    const logger = createLogger(level, (line, at) => written.push({ line, level: at }));
    return { logger, written };
}

describe("createLogger", () => {
    it("writes one JSON object per event with time, level, msg and any extra fields", () => {
        const { logger, written } = capture("debug");
        logger.info("hello", { requestId: "r-1" });

        expect(written).toHaveLength(1);
        const event = JSON.parse(written[0]?.line ?? "");
        expect(event).toMatchObject({ level: "info", msg: "hello", requestId: "r-1" });
        expect(new Date(event.time).toISOString()).toBe(event.time);
    });

    it.each(LOG_LEVELS)("at level %s, writes exactly the events at that level or above", (level) => {
        const { logger, written } = capture(level);
        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");

        expect(written.map((entry) => entry.level)).toEqual(LOG_LEVELS.slice(LOG_LEVELS.indexOf(level)));
    });

    it("keeps an event on a single line even when the message contains line breaks", () => {
        const { logger, written } = capture("info");
        logger.info("first\nsecond\r\nthird");

        expect(written).toHaveLength(1);
        expect(written[0]?.line).not.toMatch(/[\r\n]/);
        expect(JSON.parse(written[0]?.line ?? "").msg).toBe("first\nsecond\r\nthird");
    });

    it("reports its level and which levels are enabled", () => {
        const { logger } = capture("warn");
        expect(logger.level).toBe("warn");
        expect(logger.isLevelEnabled("info")).toBe(false);
        expect(logger.isLevelEnabled("warn")).toBe(true);
        expect(logger.isLevelEnabled("error")).toBe(true);
    });
});

describe("the default writer", () => {
    afterEach(() => vi.restoreAllMocks());

    it("sends debug and info to stdout, warn and error to stderr, one line per event", () => {
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        const logger = createLogger("debug");
        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");

        const text = (spy: typeof stdout) => spy.mock.calls.map((call) => String(call[0]));
        const messages = (lines: string[]) => lines.map((line) => JSON.parse(line).msg);

        expect(messages(text(stdout))).toEqual(["d", "i"]);
        expect(messages(text(stderr))).toEqual(["w", "e"]);
        expect([...text(stdout), ...text(stderr)].every((line) => line.endsWith("\n"))).toBe(true);
    });
});
