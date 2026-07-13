import {
    createPrivateKey,
    createPublicKey,
    sign as nodeSign,
    type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Ed25519Keypair } from "@socialproof/myso/keypairs/ed25519";
import { McpRuntimeError } from "./errors.js";

export interface AgentSigner {
    readonly kind: "keychain" | "development-file" | "injected" | "kms-session";
    readonly keyId: string;
    getPublicKey(): Promise<Uint8Array>;
    sign(message: Uint8Array): Promise<Uint8Array>;
    getMySoAddress(): Promise<string>;
    signTransaction(transactionBytes: Uint8Array): Promise<string>;
    destroy(): void;
}

export type KmsSigningOperation = "http-auth" | "transaction";

export interface KmsSessionPolicy {
    sessionId: string;
    keyId: string;
    accountId: string;
    agentObjectId: string;
    expectedAddress: string;
    expiresAtMs: number;
}

/** Vendor adapter; implementations may use GCP KMS, an HSM, or a TEE signer. */
export interface KmsSigningProvider {
    getPublicKey(keyId: string): Promise<Uint8Array>;
    signEd25519(keyId: string, message: Uint8Array): Promise<Uint8Array>;
    signTransaction(keyId: string, transactionBytes: Uint8Array): Promise<string>;
}

/** Must check the hosted session and current on-chain agent state, not a stale login cache. */
export interface KmsSessionAuthorizer {
    assertActive(policy: Readonly<KmsSessionPolicy>, operation: KmsSigningOperation): Promise<void>;
}

export class KmsSessionAgentSigner implements AgentSigner {
    readonly kind = "kms-session" as const;
    readonly keyId: string;
    private active = true;

    constructor(
        private readonly policy: Readonly<KmsSessionPolicy>,
        private readonly provider: KmsSigningProvider,
        private readonly authorizer: KmsSessionAuthorizer,
    ) {
        if (!policy.sessionId.trim() || !policy.keyId.trim()) {
            throw new McpRuntimeError("INVALID_CONFIGURATION", "KMS session and key identifiers are required.");
        }
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(policy.expectedAddress)) {
            throw new McpRuntimeError("INVALID_CONFIGURATION", "KMS session expectedAddress is invalid.");
        }
        this.keyId = policy.keyId;
    }

    async getPublicKey(): Promise<Uint8Array> {
        await this.guard("http-auth");
        const key = Uint8Array.from(await this.provider.getPublicKey(this.keyId));
        if (key.byteLength !== 32) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "KMS returned an invalid Ed25519 public key.");
        }
        return key;
    }

    async sign(message: Uint8Array): Promise<Uint8Array> {
        await this.guard("http-auth");
        const signature = Uint8Array.from(await this.provider.signEd25519(this.keyId, message.slice()));
        if (signature.byteLength !== 64) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "KMS returned an invalid Ed25519 signature.");
        }
        return signature;
    }

    async getMySoAddress(): Promise<string> {
        await this.guard("http-auth");
        return this.policy.expectedAddress;
    }

    async signTransaction(transactionBytes: Uint8Array): Promise<string> {
        await this.guard("transaction");
        const signature = await this.provider.signTransaction(this.keyId, transactionBytes.slice());
        if (typeof signature !== "string" || !signature.trim()) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "KMS returned an invalid transaction signature.");
        }
        return signature;
    }

    destroy(): void {
        this.active = false;
    }

    private async guard(operation: KmsSigningOperation): Promise<void> {
        if (!this.active) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The KMS signing session has been destroyed.");
        }
        if (Date.now() >= this.policy.expiresAtMs) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "The KMS signing session expired.");
        }
        await this.authorizer.assertActive(this.policy, operation);
    }
}

export interface RemoteKmsClientOptions {
    baseUrl: string;
    bearerToken(): string | Promise<string>;
    fetch?: typeof globalThis.fetch;
}

/** HTTP adapter for a private KMS/HSM signing service. No private key is returned. */
export class RemoteKmsSigningProvider implements KmsSigningProvider {
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof globalThis.fetch;

    constructor(private readonly options: RemoteKmsClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/$/, "");
        if (!this.baseUrl.startsWith("https://") && !this.baseUrl.startsWith("http://localhost")) {
            throw new McpRuntimeError("INVALID_CONFIGURATION", "Remote KMS must use HTTPS.");
        }
        this.fetchImpl = options.fetch ?? globalThis.fetch;
    }

    async getPublicKey(keyId: string): Promise<Uint8Array> {
        const response = await this.request(`/v1/keys/${encodeURIComponent(keyId)}/public-key`, {});
        return decodeBase64Field(response, "publicKey");
    }

    async signEd25519(keyId: string, message: Uint8Array): Promise<Uint8Array> {
        const response = await this.request(`/v1/keys/${encodeURIComponent(keyId)}/sign`, {
            purpose: "http-auth",
            message: Buffer.from(message).toString("base64"),
        });
        return decodeBase64Field(response, "signature");
    }

    async signTransaction(keyId: string, transactionBytes: Uint8Array): Promise<string> {
        const response = await this.request(`/v1/keys/${encodeURIComponent(keyId)}/sign`, {
            purpose: "myso-transaction",
            transactionBytes: Buffer.from(transactionBytes).toString("base64"),
        });
        if (typeof response.signature !== "string" || !response.signature.trim()) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "Remote KMS response omitted signature.");
        }
        return response.signature;
    }

    private async request(pathname: string, body: object): Promise<Record<string, unknown>> {
        const token = await this.options.bearerToken();
        const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", `Remote KMS rejected signing (${response.status}).`);
        }
        return response.json() as Promise<Record<string, unknown>>;
    }
}

export class HttpKmsSessionAuthorizer implements KmsSessionAuthorizer {
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof globalThis.fetch;

    constructor(private readonly options: RemoteKmsClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/$/, "");
        this.fetchImpl = options.fetch ?? globalThis.fetch;
    }

    async assertActive(policy: Readonly<KmsSessionPolicy>, operation: KmsSigningOperation): Promise<void> {
        const token = await this.options.bearerToken();
        const response = await this.fetchImpl(
            `${this.baseUrl}/v1/signer-sessions/${encodeURIComponent(policy.sessionId)}/authorize`,
            {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({
                    operation,
                    keyId: policy.keyId,
                    accountId: policy.accountId,
                    agentObjectId: policy.agentObjectId,
                }),
            },
        );
        if (!response.ok) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "KMS session is revoked or unauthorized.");
        }
        const result = await response.json() as { active?: unknown; expiresAtMs?: unknown };
        if (result.active !== true || !Number.isSafeInteger(result.expiresAtMs) || (result.expiresAtMs as number) <= Date.now()) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "KMS session is inactive or expired.");
        }
    }
}

function decodeBase64Field(value: Record<string, unknown>, field: string): Uint8Array {
    const encoded = value[field];
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new McpRuntimeError("SIGNER_UNAVAILABLE", `Remote KMS response omitted ${field}.`);
    }
    return Uint8Array.from(Buffer.from(encoded, "base64"));
}

export interface LocalSecretAgentSigner extends AgentSigner {
    /**
     * Makes a temporary in-process copy available to a local SDK adapter.
     * The copy is zeroed immediately after the callback resolves and must never
     * be serialized, logged, or attached to a request.
     */
    withLocalSecret<T>(callback: (secretKey: Uint8Array) => T | Promise<T>): Promise<T>;
}

export interface KeychainSignerReference {
    type: "keychain";
    service: string;
    account: string;
}

export interface DevelopmentFileSignerReference {
    type: "development-file";
    path: string;
}

export type CliSignerReference = KeychainSignerReference | DevelopmentFileSignerReference;

export interface InjectedSignerCallbacks {
    keyId: string;
    getPublicKey: () => Promise<Uint8Array> | Uint8Array;
    sign: (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;
    getMySoAddress: () => Promise<string> | string;
    signTransaction: (transactionBytes: Uint8Array) => Promise<string> | string;
    destroy?: () => void;
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function decodeSecret(value: string, source: string): Uint8Array {
    const normalized = value.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
        throw new McpRuntimeError(
            "INVALID_CONFIGURATION",
            `${source} must contain exactly one 32-byte Ed25519 secret encoded as hex.`,
        );
    }
    return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
    return createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
        format: "der",
        type: "pkcs8",
    });
}

export class LocalEd25519Signer implements LocalSecretAgentSigner {
    readonly kind: "keychain" | "development-file";
    readonly keyId: string;
    private secretKey: Uint8Array | null;
    private privateKey: KeyObject | null;
    private publicKey: Uint8Array;

    constructor(
        kind: "keychain" | "development-file",
        keyId: string,
        secretKey: Uint8Array,
    ) {
        if (secretKey.byteLength !== 32) {
            throw new McpRuntimeError("INVALID_CONFIGURATION", "Ed25519 signers require a 32-byte secret.");
        }
        this.kind = kind;
        this.keyId = keyId;
        this.secretKey = secretKey.slice();
        this.privateKey = privateKeyFromSeed(this.secretKey);
        const der = createPublicKey(this.privateKey).export({ format: "der", type: "spki" });
        this.publicKey = Uint8Array.from(Buffer.from(der).subarray(-32));
    }

    async getPublicKey(): Promise<Uint8Array> {
        this.assertActive();
        return this.publicKey.slice();
    }

    async sign(message: Uint8Array): Promise<Uint8Array> {
        this.assertActive();
        return Uint8Array.from(nodeSign(null, Buffer.from(message), this.privateKey!));
    }

    async withLocalSecret<T>(callback: (secretKey: Uint8Array) => T | Promise<T>): Promise<T> {
        this.assertActive();
        const temporary = this.secretKey!.slice();
        try {
            return await callback(temporary);
        } finally {
            temporary.fill(0);
        }
    }

    async getMySoAddress(): Promise<string> {
        return this.withLocalSecret((secret) =>
            Ed25519Keypair.fromSecretKey(secret).toMySoAddress(),
        );
    }

    async signTransaction(transactionBytes: Uint8Array): Promise<string> {
        return this.withLocalSecret(async (secret) => {
            const keypair = Ed25519Keypair.fromSecretKey(secret);
            const signed = await keypair.signTransaction(transactionBytes.slice());
            return signed.signature;
        });
    }

    destroy(): void {
        this.secretKey?.fill(0);
        this.publicKey.fill(0);
        this.secretKey = null;
        this.privateKey = null;
    }

    private assertActive(): void {
        if (!this.secretKey || !this.privateKey) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The configured signer has been destroyed.");
        }
    }
}

export class InjectedAgentSigner implements AgentSigner {
    readonly kind = "injected" as const;
    readonly keyId: string;
    private readonly callbacks: InjectedSignerCallbacks;

    constructor(callbacks: InjectedSignerCallbacks) {
        if (!callbacks.keyId.trim()) {
            throw new McpRuntimeError("INVALID_CONFIGURATION", "Injected signer keyId is required.");
        }
        this.keyId = callbacks.keyId;
        this.callbacks = callbacks;
    }

    async getPublicKey(): Promise<Uint8Array> {
        const key = Uint8Array.from(await this.callbacks.getPublicKey());
        if (key.byteLength !== 32) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "Injected signer returned an invalid public key.");
        }
        return key;
    }

    async sign(message: Uint8Array): Promise<Uint8Array> {
        const signature = Uint8Array.from(await this.callbacks.sign(message.slice()));
        if (signature.byteLength !== 64) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "Injected signer returned an invalid signature.");
        }
        return signature;
    }

    async getMySoAddress(): Promise<string> {
        const address = await this.callbacks.getMySoAddress();
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "Injected signer returned an invalid MySo address.");
        }
        return address;
    }

    async signTransaction(transactionBytes: Uint8Array): Promise<string> {
        const signature = await this.callbacks.signTransaction(transactionBytes.slice());
        if (typeof signature !== "string" || !signature.trim()) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "Injected signer returned an invalid transaction signature.");
        }
        return signature;
    }

    destroy(): void {
        this.callbacks.destroy?.();
    }
}

function expandHome(filePath: string): string {
    return filePath === "~" || filePath.startsWith("~/")
        ? path.join(os.homedir(), filePath.slice(2))
        : filePath;
}

function loadDevelopmentSecret(reference: DevelopmentFileSignerReference): Uint8Array {
    if (process.env.MEMORY_MCP_ALLOW_INSECURE_DEV_FILE !== "1") {
        throw new McpRuntimeError(
            "INVALID_CONFIGURATION",
            "Development-file signing is disabled. Set MEMORY_MCP_ALLOW_INSECURE_DEV_FILE=1 only for local development.",
        );
    }
    const resolved = path.resolve(expandHome(reference.path));
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(resolved);
    } catch (error) {
        throw new McpRuntimeError(
            "SIGNER_UNAVAILABLE",
            "The configured development signer file could not be read.",
            { cause: error },
        );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new McpRuntimeError("INVALID_CONFIGURATION", "The development signer path must be a regular file.");
    }
    if ((stat.mode & 0o077) !== 0) {
        throw new McpRuntimeError(
            "INVALID_CONFIGURATION",
            "The development signer file must have mode 0600 or stricter.",
        );
    }
    return decodeSecret(fs.readFileSync(resolved, "utf8"), "Development signer file");
}

function loadKeychainSecret(reference: KeychainSignerReference): Uint8Array {
    if (process.platform !== "darwin") {
        throw new McpRuntimeError(
            "SIGNER_UNAVAILABLE",
            "macOS Keychain signing is available only on macOS; inject a signer on other platforms.",
        );
    }
    try {
        const value = execFileSync(
            "/usr/bin/security",
            ["find-generic-password", "-w", "-s", reference.service, "-a", reference.account],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        return decodeSecret(value, "Keychain item");
    } catch (error) {
        if (error instanceof McpRuntimeError) throw error;
        throw new McpRuntimeError(
            "SIGNER_UNAVAILABLE",
            `No usable macOS Keychain item was found for service ${reference.service} and account ${reference.account}.`,
            { cause: error },
        );
    }
}

export function createCliSigner(reference: CliSignerReference): LocalSecretAgentSigner {
    if (reference.type === "keychain") {
        const secret = loadKeychainSecret(reference);
        try {
            return new LocalEd25519Signer("keychain", `${reference.service}/${reference.account}`, secret);
        } finally {
            secret.fill(0);
        }
    }

    const secret = loadDevelopmentSecret(reference);
    try {
        return new LocalEd25519Signer("development-file", path.resolve(expandHome(reference.path)), secret);
    } finally {
        secret.fill(0);
    }
}
