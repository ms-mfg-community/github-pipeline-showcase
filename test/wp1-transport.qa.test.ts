import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = process.env.WP1_QA_ARTIFACT_ROOT ?? repository;
const probe = pathToFileURL(join(repository, "test/fixtures/wp1-transport-probe.mjs")).href;
// Every HTTP suite that serves its app over one pooled named pipe / Unix socket: the endpoint's name (wp1-<name>-...),
// the suite's test file and how many tests it holds. Each test sends at least one request.
const SUITES = [
    ["body-parser", "test/body-parser.delta.qa.test.ts", 13],
    ["compression", "test/compression.delta.qa.test.ts", 32],
    ["app", "test/app.test.ts", 70],
    ["contract", "test/app.contract.qa.test.ts", 9],
    ["ui", "test/ui.qa.test.ts", 6],
] as const;
const TOTAL = SUITES.reduce((sum, [, , count]) => sum + count, 0);
type Transport = {
    endpoint: string;
    ipc: boolean;
    requests: number;
    connections: number;
    tcpConnectCalls: number;
    syncCompressionWhileListening: number;
    remainingSockets: number;
};
type Run = { error?: Error; status: number | null; stdout: string; stderr: string };
// A ceiling, not a delay: the nested run takes a few seconds on an idle machine and many times that when every CPU is
// busy. It is asynchronous, so the Vitest worker that waits for it stays responsive instead of being frozen for minutes.
const RUN_TIMEOUT_MS = 480_000;
let child: Run;
let evidence: Transport[] = [];
let assertions: Array<{ status: string }> = [];

beforeAll(async () => {
    child = await new Promise<Run>((resolve) => {
        const nested = spawn(process.execPath, [
            join(repository, "node_modules/vitest/vitest.mjs"),
            "run", "--root", artifactRoot, "--reporter=json",
            "--pool=forks", "--maxWorkers=1", "--minWorkers=1",
            ...SUITES.map(([, file]) => file),
        ], {
            cwd: artifactRoot,
            env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${probe}`.trim() },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let error: Error | undefined;
        nested.stdout.on("data", (chunk) => { stdout += String(chunk); });
        nested.stderr.on("data", (chunk) => { stderr += String(chunk); });
        nested.once("error", (spawnError) => { error = spawnError; });
        const timer = setTimeout(() => {
            error = new Error(`the nested Vitest run did not finish within ${RUN_TIMEOUT_MS} ms (ETIMEDOUT)`);
            nested.kill();
        }, RUN_TIMEOUT_MS);
        nested.once("close", (status) => {
            clearTimeout(timer);
            resolve({ error, status, stdout, stderr });
        });
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    evidence = [...`${stdout}\n${stderr}`.matchAll(/WP1_TRANSPORT_PROBE (\{[^\r\n]+\})/g)]
        .map((match) => JSON.parse(match[1]!) as Transport);
    // A nested run that was killed or crashed leaves no JSON report. The tests below then fail on child.error or
    // child.status with the run's own output, rather than this hook failing on an empty string.
    try {
        const report = JSON.parse(stdout) as { testResults: Array<{ assertionResults: Array<{ status: string }> }> };
        assertions = report.testResults.flatMap((result) => result.assertionResults);
    } catch {
        assertions = [];
    }
}, RUN_TIMEOUT_MS + 30_000);

describe("WP1 stabilization preserves assertions and changes only transport/precomputation", () => {
    it.each(SUITES)("%s suite executes all assertions over one pooled IPC server and closes it cleanly", (name, _file, count) => {
        expect(child.error).toBeUndefined();
        expect(child.status, child.stdout + child.stderr).toBe(0);
        expect(assertions).toHaveLength(TOTAL);
        expect(assertions.filter((assertion) => assertion.status === "passed")).toHaveLength(TOTAL);
        const servers = evidence.filter((entry) => entry.endpoint.includes(`wp1-${name}-`));
        expect(servers, JSON.stringify(evidence)).toHaveLength(1);
        const server = servers[0]!;
        expect(server.ipc).toBe(true);
        expect(server.requests).toBeGreaterThan(count);
        expect(server.connections).toBeGreaterThan(0);
        expect(server.connections).toBeLessThan(server.requests);
        expect(server.tcpConnectCalls).toBe(0);
        expect(server.syncCompressionWhileListening).toBe(0);
        expect(server.remainingSockets).toBe(0);
        expect(evidence).toHaveLength(SUITES.length);
    });
});
