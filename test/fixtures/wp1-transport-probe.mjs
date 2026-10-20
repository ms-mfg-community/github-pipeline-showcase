// Loaded only by wp1-transport.qa.test.ts's disposable Vitest subprocess.
// Observe actual HTTP transport and compression calls without changing either QA suite.
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import zlib from "node:zlib";

const listening = new Map();
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
    const endpoint = args[0];
    const ipc = typeof endpoint === "string" || (endpoint && typeof endpoint === "object" && typeof endpoint.path === "string");
    const sockets = new Set();
    const evidence = {
        endpoint: typeof endpoint === "string" ? endpoint : "TCP",
        ipc,
        requests: 0,
        connections: 0,
        tcpConnectCalls: 0,
        syncCompressionWhileListening: 0,
    };
    listening.set(this, evidence);
    this.on("request", () => { evidence.requests += 1; });
    this.on("connection", (socket) => {
        evidence.connections += 1;
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    this.once("close", () => {
        listening.delete(this);
        // Socket `close` notifications can follow the server's close notification on Windows;
        // destroyed is the observable resource state, not callback ordering.
        const remainingSockets = [...sockets].filter((socket) => !socket.destroyed).length;
        process.stderr.write(`WP1_TRANSPORT_PROBE ${JSON.stringify({ ...evidence, remainingSockets })}\n`);
    });
    return originalListen.apply(this, args);
};

const originalConnect = net.createConnection;
net.createConnection = function (...args) {
    const endpoint = args[0];
    const ipc = typeof endpoint === "string" || (endpoint && typeof endpoint === "object" && typeof endpoint.path === "string");
    if (!ipc) {
        for (const evidence of listening.values()) evidence.tcpConnectCalls += 1;
    }
    return originalConnect.apply(this, args);
};

for (const name of ["gzipSync", "deflateSync", "brotliCompressSync"]) {
    const originalCompress = zlib[name];
    zlib[name] = function (...args) {
        for (const evidence of listening.values()) evidence.syncCompressionWhileListening += 1;
        return originalCompress.apply(this, args);
    };
}
syncBuiltinESMExports();
