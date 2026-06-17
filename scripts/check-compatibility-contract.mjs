#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relPath) {
    return fs.readFileSync(path.join(root, relPath), "utf8");
}

function json(relPath) {
    return JSON.parse(read(relPath));
}

function capture(label, text, regex) {
    const match = text.match(regex);
    if (!match) {
        throw new Error(`Missing ${label}`);
    }
    return match[1];
}

function assertEqual(label, actual, expected) {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

const serverCargo = read("services/server/Cargo.toml");
const serverCompatibility = read("services/server/src/compatibility.rs");
const tsPackage = json("packages/sdk/package.json");
const sdkCompatibility = read("packages/sdk/src/compatibility.ts");
const policyDoc = read("docs/relayer/versioning-and-compatibility.md");

const relayerPackageVersion = capture(
    "server package version",
    serverCargo,
    /^version\s*=\s*"([^"]+)"/m,
);
const apiVersion = capture(
    "RELAYER_API_VERSION",
    serverCompatibility,
    /RELAYER_API_VERSION:\s*&str\s*=\s*"([^"]+)"/,
);
const minTypescript = capture(
    "MIN_TYPESCRIPT_SDK_VERSION",
    serverCompatibility,
    /MIN_TYPESCRIPT_SDK_VERSION:\s*&str\s*=\s*"([^"]+)"/,
);
const minMcp = capture(
    "MIN_MCP_PACKAGE_VERSION",
    serverCompatibility,
    /MIN_MCP_PACKAGE_VERSION:\s*&str\s*=\s*"([^"]+)"/,
);

const tsSdkVersion = capture(
    "MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION",
    sdkCompatibility,
    /MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION\s*=\s*"([^"]+)"/,
);

assertEqual("Rust min TypeScript SDK", minTypescript, tsSdkVersion);

for (const value of [apiVersion, relayerPackageVersion, minTypescript, minMcp]) {
    if (!policyDoc.includes(value)) {
        throw new Error(`versioning policy doc missing ${value}`);
    }
}

console.log("compatibility contract OK");
