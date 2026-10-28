import { MultiSigPublicKey } from "@socialproof/myso/multisig";
import type { PublicKey } from "@socialproof/myso/cryptography";
import { Ed25519PublicKey } from "@socialproof/myso/keypairs/ed25519";
import { Secp256k1PublicKey } from "@socialproof/myso/keypairs/secp256k1";
import { Secp256r1PublicKey } from "@socialproof/myso/keypairs/secp256r1";
import { PasskeyPublicKey } from "@socialproof/myso/keypairs/passkey";
import { ZkLoginPublicIdentifier } from "@socialproof/myso/zklogin";

export interface MultisigMemberInput {
    address: string;
    publicKeyBase64: string;
    weight: number;
}

function canonicalAddress(address: string): string {
    return `0x${address.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
}

function resolvePublicKey(member: MultisigMemberInput): PublicKey {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(member.address)) {
        throw new Error(`Invalid multisig member address: ${member.address}`);
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(member.publicKeyBase64)) {
        throw new Error(`Invalid base64 public key for ${member.address}`);
    }
    const raw = Buffer.from(member.publicKeyBase64, "base64");
    if (!raw.length || raw.toString("base64") !== member.publicKeyBase64) {
        throw new Error(`Invalid base64 public key for ${member.address}`);
    }
    const candidates: PublicKey[] = [];
    for (const KeyType of [Ed25519PublicKey, Secp256k1PublicKey, Secp256r1PublicKey, PasskeyPublicKey, ZkLoginPublicIdentifier]) {
        try {
            candidates.push(new KeyType(raw));
        } catch {
            // Key length and encoding differ between the supported schemes.
        }
    }
    const matches = candidates.filter((key) => key.verifyAddress(member.address));
    if (matches.length !== 1) {
        throw new Error(`Public key does not resolve uniquely to the advertised MySo address ${member.address}`);
    }
    return matches[0]!;
}

export function configureMySoMultisig(threshold: number, members: MultisigMemberInput[]) {
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 2550) {
        throw new Error("Multisig threshold must be an integer between 1 and 2550");
    }
    if (!Array.isArray(members) || members.length < 2 || members.length > 10) {
        throw new Error("A MySo multisig needs between 2 and 10 wallet members");
    }
    if (new Set(members.map(({ address }) => canonicalAddress(address))).size !== members.length) {
        throw new Error("Each MySo address can appear only once in a multisig");
    }
    for (const member of members) {
        if (!Number.isInteger(member.weight) || member.weight < 1 || member.weight > 255) {
            throw new Error("Every multisig member weight must be an integer from 1 to 255");
        }
    }
    const totalWeight = members.reduce((sum, member) => sum + member.weight, 0);
    if (threshold > totalWeight) throw new Error("Multisig threshold cannot exceed total member weight");
    const publicKey = MultiSigPublicKey.fromPublicKeys({
        threshold,
        publicKeys: members.map((member) => ({ publicKey: resolvePublicKey(member), weight: member.weight })),
    });
    return {
        format: "myso-protocol-multisig-v1",
        address: publicKey.toMySoAddress(),
        publicKeyBase64: Buffer.from(publicKey.toRawBytes()).toString("base64"),
        threshold,
        members: members.map(({ address, publicKeyBase64, weight }) => ({ address: canonicalAddress(address), publicKeyBase64, weight })),
        execution: "This tool only derives a protocol multisig configuration. To make it an account owner, propose the returned address through account owner migration; the new multisig must sign the acceptance transactions with the configured member wallets.",
    };
}
