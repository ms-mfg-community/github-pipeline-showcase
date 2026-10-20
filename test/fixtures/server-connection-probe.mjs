// Observation only: preload in the disposable server-suite worker. Emit immediately, because Vitest
// can terminate a worker without running its JavaScript exit handlers. Do not alter pooling or timing.
import { ChildProcess } from "node:child_process";
import net from "node:net";

const report = (event, port) => process.stderr.write(
    `WP1_SERVER_CONNECTION_PROBE ${JSON.stringify({ event, port: Number(port) })}\n`,
);

// Register before spawn() returns to the suite, so the observation precedes its stdout handlers.
// The record means the parent received the child's JSON announcement, not just that a port opened.
const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (...args) {
    const result = spawn.apply(this, args);
    if (args[0]?.args?.some((arg) => String(arg).replaceAll("\\", "/").endsWith("/dist/server.js"))) {
        let stdout = "";
        let announced = false;
        this.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
            if (announced) return;
            for (const line of stdout.split(/\r?\n/)) {
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                if (message?.msg === "server listening" && Number.isInteger(message.port)) {
                    announced = true;
                    report("announced", message.port);
                    break;
                }
            }
        });
    }
    return result;
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const port = typeof options === "number" ? options : options && typeof options === "object" ? options.port : undefined;
    if (port !== undefined) {
        report("attempt", port);
        this.once("connect", () => report("connected", port));
    }
    return connect.apply(this, args);
};
