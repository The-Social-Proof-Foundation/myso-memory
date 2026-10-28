#!/usr/bin/env node

import { formatStartupError } from "../errors.js";
import { loadHostedMcpConfig, startHostedMcpServer } from "../hosted-runtime.js";

try {
    const config = loadHostedMcpConfig(process.env);
    const server = startHostedMcpServer(config);
    server.once("listening", () => {
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : config.port;
        process.stderr.write(`memory-mcp-http listening on ${port}\n`);
    });
    server.once("error", (error) => {
        process.stderr.write(`memory-mcp-http: ${formatStartupError(error)}\n`);
        process.exitCode = 1;
    });
} catch (error) {
    process.stderr.write(`memory-mcp-http: ${formatStartupError(error)}\n`);
    process.exitCode = 1;
}
