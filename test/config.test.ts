import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

// The defaults exactly as SPEC.md §5.2 states them — deliberately not imported from the
// implementation, so a drifting default fails here instead of being echoed back.
const SPEC_DEFAULTS = {
    port: 3000,
    appEnv: "local",
    appVersion: "0.0.0-dev",
    gitCommit: "unknown",
    logLevel: "info",
    enableInsecureDemo: false,
};

function load(env: Record<string, string | undefined>) {
    const warnings: string[] = [];
    const config = loadConfig(env, (message) => warnings.push(message));
    return { config, warnings };
}

describe("loadConfig — defaults", () => {
    it("uses the documented default for every variable when none is set, without warning", () => {
        const { config, warnings } = load({});
        expect(config).toEqual(SPEC_DEFAULTS);
        expect(warnings).toEqual([]);
    });

    it("treats a variable that is present but undefined as unset", () => {
        const { config, warnings } = load({ PORT: undefined, LOG_LEVEL: undefined });
        expect(config).toEqual(SPEC_DEFAULTS);
        expect(warnings).toEqual([]);
    });
});

describe("loadConfig — valid values", () => {
    it("reads every variable", () => {
        const { config, warnings } = load({
            PORT: "8080",
            APP_ENV: "staging",
            APP_VERSION: "1.2.3",
            GIT_COMMIT: "abc1234",
            LOG_LEVEL: "debug",
            ENABLE_INSECURE_DEMO: "true",
        });
        expect(config).toEqual({
            port: 8080,
            appEnv: "staging",
            appVersion: "1.2.3",
            gitCommit: "abc1234",
            logLevel: "debug",
            enableInsecureDemo: true,
        });
        expect(warnings).toEqual([]);
    });

    it.each(["debug", "info", "warn", "error"] as const)("accepts LOG_LEVEL=%s", (level) => {
        const { config, warnings } = load({ LOG_LEVEL: level });
        expect(config.logLevel).toBe(level);
        expect(warnings).toEqual([]);
    });

    it.each([
        ["0", 0],
        ["1", 1],
        ["65535", 65535],
        ["03000", 3000],
    ])("accepts PORT=%s", (raw, expected) => {
        const { config, warnings } = load({ PORT: raw });
        expect(config.port).toBe(expected);
        expect(warnings).toEqual([]);
    });

    it("trims surrounding whitespace from the label variables", () => {
        const { config } = load({ APP_ENV: "  prod ", APP_VERSION: " 2.0.0\n", GIT_COMMIT: "\tdeadbeef " });
        expect(config).toMatchObject({ appEnv: "prod", appVersion: "2.0.0", gitCommit: "deadbeef" });
    });

    it('accepts ENABLE_INSECURE_DEMO="false"', () => {
        const { config, warnings } = load({ ENABLE_INSECURE_DEMO: "false" });
        expect(config.enableInsecureDemo).toBe(false);
        expect(warnings).toEqual([]);
    });
});

describe("loadConfig — invalid values fall back to the default with exactly one warning", () => {
    const invalid: Array<[name: string, value: string]> = [
        ["PORT", "abc"],
        ["PORT", "-1"],
        ["PORT", "65536"],
        ["PORT", "3000.5"],
        ["PORT", "0x10"],
        ["PORT", "1e3"],
        ["PORT", ""],
        ["PORT", " 3000"],
        ["PORT", "9".repeat(50)],
        ["APP_ENV", ""],
        ["APP_ENV", "   "],
        ["APP_VERSION", ""],
        ["APP_VERSION", " \t "],
        ["GIT_COMMIT", ""],
        ["GIT_COMMIT", "\n"],
        ["LOG_LEVEL", "verbose"],
        ["LOG_LEVEL", "INFO"],
        ["LOG_LEVEL", ""],
        ["ENABLE_INSECURE_DEMO", "TRUE"],
        ["ENABLE_INSECURE_DEMO", "True"],
        ["ENABLE_INSECURE_DEMO", "1"],
        ["ENABLE_INSECURE_DEMO", "yes"],
        ["ENABLE_INSECURE_DEMO", " true"],
        ["ENABLE_INSECURE_DEMO", ""],
    ];

    it.each(invalid)("%s=%j", (name, value) => {
        const { config, warnings } = load({ [name]: value });
        expect(config).toEqual(SPEC_DEFAULTS);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(name);
    });

    it("warns once per invalid variable and still applies the valid ones", () => {
        const { config, warnings } = load({
            PORT: "not-a-port",
            LOG_LEVEL: "loud",
            ENABLE_INSECURE_DEMO: "maybe",
            APP_ENV: "production",
            GIT_COMMIT: "abc1234",
        });
        expect(config).toEqual({ ...SPEC_DEFAULTS, appEnv: "production", gitCommit: "abc1234" });
        expect(warnings).toHaveLength(3);
        expect(warnings.some((w) => w.includes("PORT"))).toBe(true);
        expect(warnings.some((w) => w.includes("LOG_LEVEL"))).toBe(true);
        expect(warnings.some((w) => w.includes("ENABLE_INSECURE_DEMO"))).toBe(true);
    });

    it("never throws, whatever the environment contains", () => {
        const hostile = {
            PORT: "9".repeat(10_000),
            APP_ENV: "\u0000",
            LOG_LEVEL: "\n",
            ENABLE_INSECURE_DEMO: "\u0000",
        };
        expect(() => load(hostile)).not.toThrow();
        expect(load(hostile).config.enableInsecureDemo).toBe(false);
    });
});

describe("the process-wide config", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("survives a bad environment at import time: defaults plus a single warning on stderr", async () => {
        vi.resetModules();
        vi.stubEnv("PORT", "not-a-port");
        vi.stubEnv("LOG_LEVEL", "info");
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        const { config } = await import("../src/config.js");

        expect(config.port).toBe(SPEC_DEFAULTS.port);
        expect(stderr).toHaveBeenCalledTimes(1);
        expect(String(stderr.mock.calls[0]?.[0])).toContain("PORT");
    });
});
