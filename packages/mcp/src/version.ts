import fs from "node:fs";

export const MCP_PACKAGE_NAME = "@socialproof/memory-mcp";

interface PackageMetadata {
    name?: unknown;
    version?: unknown;
}

interface ValidPackageMetadata {
    name: string;
    version: string;
}

function readPackageMetadata(): ValidPackageMetadata {
    const packageUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(packageUrl, "utf8")) as PackageMetadata;
    if (parsed.name !== MCP_PACKAGE_NAME || typeof parsed.version !== "string") {
        throw new Error("memory-mcp package metadata is invalid");
    }
    return { name: parsed.name, version: parsed.version };
}

export const MCP_PACKAGE_VERSION = readPackageMetadata().version;
export const MCP_SERVER_NAME = "memory-mcp";
