import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The authorized task requires one real TCP connection per serving test (three in all), none of them made before the
// server is listening, while the server suite keeps its real HTTP and PORT assertions. This counts native
// Socket.connect calls and completed handshakes in the real server suite, not fetch calls or a helper's own claim
// about connection pooling.
//
// One nested run of test/server.qa.test.ts serves all tests below. The compiled warn-level child's boot is delayed
// by 2.5 s, well within the suite's startup allowance, to model a machine whose CPUs are busy. That changes nothing
// about how many connections a correct suite makes, and it exposes one that connects to a quiet child before the
// child is listening: its first request meets a closed port.
const repository = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = process.env.WP1_SERVER_CONNECTION_ARTIFACT_ROOT ?? repository;
const probe = pathToFileURL(join(repository, "test/fixtures/server-connection-probe.mjs")).href;
// A ceiling, not a delay. The nested run compiles the server and boots three of them, which takes many times its
// usual few seconds when every CPU is busy. The run is asynchronous, so the Vitest worker that waits for it stays
// responsive instead of being frozen for minutes.
const RUN_TIMEOUT_MS = 480_000;
const delayedQuietBoot = String.raw`
    const entry = String(process.argv[1] ?? "").replaceAll("\\", "/");
    if (entry.endsWith("/dist/server.js") && process.env.LOG_LEVEL === "warn") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
    }
`;
type Connection = { event: string; port: number };
type TestReport = { testResults: Array<{ assertionResults: Array<{ status: string }> }> };
type Run = { error?: Error; status: number | null; stdout: string; stderr: string };
let nested: Run;

beforeAll(async () => {
    nested = await new Promise<Run>((resolve) => {
        const child = spawn(process.execPath, [
            join(repository, "node_modules/vitest/vitest.mjs"), "run", "--root", artifactRoot,
            "--pool=forks", "--maxWorkers=1", "--minWorkers=1", "--reporter=json", "test/server.qa.test.ts",
        ], {
            cwd: artifactRoot,
            env: {
                ...process.env,
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${probe} --import=data:text/javascript,${encodeURIComponent(delayedQuietBoot)}`.trim(),
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let error: Error | undefined;
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", (spawnError) => { error = spawnError; });
        const timer = setTimeout(() => {
            error = new Error(`the nested Vitest run did not finish within ${RUN_TIMEOUT_MS} ms (ETIMEDOUT)`);
            child.kill();
        }, RUN_TIMEOUT_MS);
        child.once("close", (status) => {
            clearTimeout(timer);
            resolve({ error, status, stdout, stderr });
        });
    });
}, RUN_TIMEOUT_MS + 30_000);

// The evidence is read in each test, not in the hook, so a run that failed or was killed is reported by the tests
// with its own output instead of as an error in the hook.
function connections() {
    const output = nested.stdout + nested.stderr;
    expect(nested.error, output).toBeUndefined();
    expect(nested.status, output).toBe(0);
    const report = JSON.parse(nested.stdout) as TestReport;
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    expect(assertions).toHaveLength(4);
    expect(assertions.every(({ status }) => status === "passed")).toBe(true);

    const evidence = [...output.matchAll(/WP1_SERVER_CONNECTION_PROBE (\{[^\r\n]+\})/g)]
        .map((match) => JSON.parse(match[1]!) as Connection);
    const attempts = evidence.filter(({ event }) => event === "attempt");
    const connected = evidence.filter(({ event }) => event === "connected");
    const perPort = new Map<number, number>();
    for (const { port } of connected) perPort.set(port, (perPort.get(port) ?? 0) + 1);
    return { evidence, attempts, connected, perPort };
}

describe("QA — the real compiled-server transport meets the authorized stabilization contract", () => {
    it("makes one TCP connection for each of the three serving processes while retaining every server assertion", () => {
        const { evidence, attempts, connected, perPort } = connections();
        expect(perPort.size, JSON.stringify(evidence)).toBe(3);
        expect([...perPort.values()].sort(), `Successful TCP connections per serving test: ${JSON.stringify([...perPort])}`)
            .toEqual([1, 1, 1]);
        expect(attempts, `TCP attempts: ${JSON.stringify(evidence)}`).toHaveLength(3);
        expect(connected).toHaveLength(3);
    });

    it("never connects to a closed port when the quiet child's boot takes 2.5 seconds", () => {
        const { evidence, attempts, connected, perPort } = connections();
        expect(perPort.size, JSON.stringify(evidence)).toBe(3);
        expect(attempts, `TCP attempts must not precede listening: ${JSON.stringify(evidence)}`).toHaveLength(connected.length);
    });

    it("attempts TCP only after that serving process's stdout announcement reaches the suite", () => {
        const { evidence } = connections();
        const announcements = evidence.filter(({ event }) => event === "announced");
        expect(announcements, `TCP attempts need three real stdout announcements: ${JSON.stringify(evidence)}`).toHaveLength(3);
        const announced = new Set<number>();
        for (const { event, port } of evidence) {
            if (event === "announced") announced.add(port);
            if (event === "attempt") {
                expect(announced.has(port), `TCP attempts must follow their stdout announcement: ${JSON.stringify(evidence)}`).toBe(true);
            }
        }
    });
});
