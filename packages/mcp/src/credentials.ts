import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SocialChainConfig } from "@socialproof/social";
import { McpRuntimeError } from "./errors.js";
import type {
    CliSignerReference,
    DevelopmentFileSignerReference,
    KeychainSignerReference,
} from "./signers.js";

export const DEFAULT_CREDENTIALS_PATH = path.join(os.homedir(), ".memory", "credentials.json");

export interface McpCredentials {
    accountId: string;
    serverUrl: string;
    platformId?: string;
    socialEnabled: boolean;
    socialGatewayUrl: string;
    social?: {
        /** Optional deployment pin. Authenticated agent context remains authoritative. */
        network?: "mainnet" | "testnet" | "devnet" | "localnet";
        /** Optional deployment pin. Authenticated agent context remains authoritative. */
        rpcUrl?: string;
        /** Optional object-id pins for deployments that previously configured them locally. */
        chain?: Partial<SocialChainConfig>;
    };
    signer: CliSignerReference;
}

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, label: string): JsonObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new McpRuntimeError("INVALID_CONFIGURATION", `${label} must be a JSON object.`);
    }
    return value as JsonObject;
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new McpRuntimeError("INVALID_CONFIGURATION", `${label} must be a non-empty string.`);
    }
    return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    return requireNonEmptyString(value, label);
}

function normalizeUrl(value: unknown, label: string, fallback: string): string {
    const raw = optionalString(value, label) ?? fallback;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new McpRuntimeError("INVALID_CONFIGURATION", `${label} must be an absolute HTTP(S) URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new McpRuntimeError("INVALID_CONFIGURATION", `${label} must use HTTP or HTTPS.`);
    }
    const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);
    if (parsed.protocol === "http:" && !localHostnames.has(parsed.hostname)) {
        throw new McpRuntimeError(
            "INVALID_CONFIGURATION",
            `${label} must use HTTPS unless it targets localhost.`,
        );
    }
    return parsed.toString().replace(/\/$/, "");
}

function parseSigner(value: unknown): CliSignerReference {
    const signer = requireObject(value, "signer");
    if (signer.type === "keychain") {
        const parsed: KeychainSignerReference = {
            type: "keychain",
            service: requireNonEmptyString(signer.service, "signer.service"),
            account: requireNonEmptyString(signer.account, "signer.account"),
        };
        return parsed;
    }
    if (signer.type === "development-file") {
        const parsed: DevelopmentFileSignerReference = {
            type: "development-file",
            path: requireNonEmptyString(signer.path, "signer.path"),
        };
        return parsed;
    }
    if (signer.type === "injected") {
        throw new McpRuntimeError(
            "INVALID_CONFIGURATION",
            "Injected signers must be supplied programmatically and cannot be configured in credentials.json.",
        );
    }
    throw new McpRuntimeError(
        "INVALID_CONFIGURATION",
        "signer.type must be keychain or development-file.",
    );
}

function parseSocialChain(value: unknown): Partial<SocialChainConfig> | undefined {
    if (value === undefined) return undefined;
    const chain = requireObject(value, "socialChain");
    const parsed: Partial<SocialChainConfig> = {};
    const fields = [
        "packageId",
        "usernameRegistryId",
        "platformRegistryId",
        "platformObjectId",
        "blockListRegistryId",
        "postConfigId",
        "memoryConfigId",
        "mydataRegistryId",
        "clockId",
        "socialGraphId",
        "messagingPackageId",
        "messagingVersionId",
        "messagingConfigId",
        "messagingNamespaceId",
        "messagingGroupManagerId",
        "messagingGroupLeaverId",
    ] as const satisfies readonly (keyof SocialChainConfig)[];
    for (const field of fields) {
        const configured = optionalString(chain[field], `socialChain.${field}`);
        if (configured !== undefined) parsed[field] = configured;
    }
    return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseNetwork(value: unknown): "mainnet" | "testnet" | "devnet" | "localnet" | undefined {
    if (value === undefined) return undefined;
    if (value === "mainnet" || value === "testnet" || value === "devnet" || value === "localnet") {
        return value;
    }
    throw new McpRuntimeError(
        "INVALID_CONFIGURATION",
        "mysoNetwork must be mainnet, testnet, devnet, or localnet when provided.",
    );
}

export function parseCredentials(value: unknown): McpCredentials {
    const input = requireObject(value, "credentials");
    if ("key" in input || "ownerCoSignKey" in input) {
        throw new McpRuntimeError(
            "UNSAFE_LEGACY_CREDENTIALS",
            "Raw key and ownerCoSignKey fields are no longer accepted. Store the agent key in macOS Keychain and configure a signer reference; owner operations require the future approval flow.",
        );
    }

    const accountId = requireNonEmptyString(input.accountId, "accountId");
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(accountId)) {
        throw new McpRuntimeError(
            "INVALID_CONFIGURATION",
            "accountId must be a valid MySo object ID.",
        );
    }
    const serverUrl = normalizeUrl(
        input.serverUrl,
        "serverUrl",
        "https://memory.mysocial.network",
    );
    const socialGatewayUrl = normalizeUrl(
        input.socialGatewayUrl,
        "socialGatewayUrl",
        serverUrl,
    );
    if (input.socialEnabled !== undefined && typeof input.socialEnabled !== "boolean") {
        throw new McpRuntimeError("INVALID_CONFIGURATION", "socialEnabled must be a boolean.");
    }

    const socialEnabled = input.socialEnabled === true;
    const social = socialEnabled
        ? {
              network: parseNetwork(input.mysoNetwork),
              rpcUrl: input.mysoRpcUrl === undefined
                  ? undefined
                  : normalizeUrl(input.mysoRpcUrl, "mysoRpcUrl", ""),
              chain: parseSocialChain(input.socialChain),
          }
        : undefined;

    return {
        accountId,
        serverUrl,
        platformId: optionalString(input.platformId, "platformId"),
        socialEnabled,
        socialGatewayUrl,
        social,
        signer: parseSigner(input.signer),
    };
}

export function loadCredentials(
    credentialsPath = process.env.MEMORY_MCP_CREDENTIALS_FILE ?? DEFAULT_CREDENTIALS_PATH,
): McpCredentials {
    let raw: string;
    try {
        const stat = fs.lstatSync(credentialsPath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
            throw new McpRuntimeError(
                "INVALID_CONFIGURATION",
                `MCP credentials at ${credentialsPath} must be a regular file that is not group- or world-writable.`,
            );
        }
        raw = fs.readFileSync(credentialsPath, "utf8");
    } catch (error) {
        if (error instanceof McpRuntimeError) throw error;
        throw new McpRuntimeError(
            "INVALID_CONFIGURATION",
            `Unable to read MCP credentials from ${credentialsPath}.`,
            { cause: error },
        );
    }

    try {
        return parseCredentials(JSON.parse(raw));
    } catch (error) {
        if (error instanceof McpRuntimeError) throw error;
        throw new McpRuntimeError(
            "INVALID_CONFIGURATION",
            `MCP credentials at ${credentialsPath} are not valid JSON.`,
            { cause: error },
        );
    }
}
