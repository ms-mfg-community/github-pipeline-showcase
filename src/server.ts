// Process entry point: HTTP wiring only. Behaviour lives in app.ts so it can be tested
// without opening a port.

import { app } from "./app.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const logger = createLogger(config.logLevel);
const SHUTDOWN_TIMEOUT_MS = 10_000;

const server = app.listen(config.port, (error?: Error) => {
    // Express 5 passes a listen failure (for example EADDRINUSE) to this callback.
    if (error !== undefined) {
        logger.error("failed to start server", { port: config.port, message: error.message });
        process.exit(1);
    }
    const address = server.address();
    logger.info("server listening", {
        port: typeof address === "object" && address !== null ? address.port : config.port,
        environment: config.appEnv,
        version: config.appVersion,
        commit: config.gitCommit,
    });
});

// In a container node is PID 1, which gets no default signal handling: without these handlers
// `docker stop` would wait out its grace period and then SIGKILL the process.
function shutdown(signal: NodeJS.Signals): void {
    logger.info("shutting down", { signal });
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    server.close((error) => process.exit(error === undefined ? 0 : 1));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
