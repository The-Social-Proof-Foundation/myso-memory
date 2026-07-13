import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { McpRuntimeError } from "./errors.js";
import { LocalEd25519Signer } from "./signers.js";

export interface ProvisionedAgentSigner {
    publicKeyHex: string;
    derivedAddress: string;
    signer: {
        type: "keychain" | "kms-session";
        keyId: string;
        service?: string;
        account?: string;
    };
}

export interface AgentSignerProvisioner {
    provision(label: string): Promise<ProvisionedAgentSigner>;
}

/** Generates an Ed25519 seed and stores it in macOS Keychain without returning it. */
export class LocalKeychainAgentProvisioner implements AgentSignerProvisioner {
    constructor(private readonly service = "network.mysocial.memory-agent") {}

    async provision(label: string): Promise<ProvisionedAgentSigner> {
        if (process.platform !== "darwin") {
            throw new McpRuntimeError(
                "SIGNER_UNAVAILABLE",
                "Local agent provisioning requires macOS Keychain; hosted runtimes must inject a KMS provisioner.",
            );
        }
        const account = label.trim();
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(account)) {
            throw new McpRuntimeError(
                "INVALID_ARGUMENT",
                "Agent signer label must contain 1-64 letters, numbers, dots, underscores, or hyphens.",
            );
        }
        try {
            execFileSync("/usr/bin/security", [
                "find-generic-password",
                "-s",
                this.service,
                "-a",
                account,
            ], { stdio: "ignore" });
            throw new McpRuntimeError(
                "CONFLICT",
                "A Keychain signer already exists for this label; choose a new label.",
            );
        } catch (error) {
            if (error instanceof McpRuntimeError) throw error;
        }

        const secret = Uint8Array.from(randomBytes(32));
        const signer = new LocalEd25519Signer("keychain", `${this.service}:${account}`, secret);
        try {
            const [publicKey, derivedAddress] = await Promise.all([
                signer.getPublicKey(),
                signer.getMySoAddress(),
            ]);
            execFileSync("/usr/bin/security", [
                "add-generic-password",
                "-s",
                this.service,
                "-a",
                account,
                "-w",
                Buffer.from(secret).toString("hex"),
            ], { stdio: ["ignore", "ignore", "ignore"] });
            return {
                publicKeyHex: Buffer.from(publicKey).toString("hex"),
                derivedAddress,
                signer: {
                    type: "keychain",
                    keyId: `${this.service}:${account}`,
                    service: this.service,
                    account,
                },
            };
        } catch (error) {
            throw new McpRuntimeError("SIGNER_UNAVAILABLE", "Unable to provision the agent signer.", {
                cause: error,
            });
        } finally {
            signer.destroy();
            secret.fill(0);
        }
    }
}
