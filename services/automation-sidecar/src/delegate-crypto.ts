/**
 * Encrypted delegate keys.
 *
 * A delegate seed is encrypted in the user's browser to the bridge's X25519 public
 * key and travels (memory relayer, automation engine, Postgres) only as
 * ciphertext. Nothing between the browser and the bridge can read it, and the
 * database holds nothing usable without the bridge's MyData private key, which
 * lives only in the bridge's environment.
 *
 * Envelope (base64url):  version(1) | ephemeralPublic(32) | iv(12) | ciphertext+tag
 *   shared = X25519(ephemeralPrivate, bridgePublic)
 *   key    = HKDF-SHA256(shared, salt = ephemeralPublic | bridgePublic, info)
 *   cipher = AES-256-GCM, additional data = {@link delegateAad}
 *
 * The additional data binds the ciphertext to its account, name and on-chain
 * agent, so a encrypted key copied into another row fails to open instead of
 * quietly signing for the wrong account. The chat-app implements the encrypting
 * half of this exact format with WebCrypto.
 */

import {
    createCipheriv,
    createDecipheriv,
    createPrivateKey,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
} from "node:crypto";

import { normalizeObjectId } from "./ids.js";

const ENVELOPE_VERSION = 1;
const HKDF_INFO = "myso-automation-delegate-v1";
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const SEED_BYTES = 32;

export class DelegateCryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DelegateCryptoError";
    }
}

/** Additional authenticated data. Mirror exactly in every encryptor. */
export function delegateAad(accountId: string, delegateRef: string, agentObjectId: string): Buffer {
    return Buffer.from(
        `myso-delegate-v1|${normalizeObjectId(accountId)}|${delegateRef}|${normalizeObjectId(agentObjectId)}`,
        "utf8",
    );
}

function privateKeyObject(raw: Buffer) {
    return createPrivateKey({
        key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
        format: "der",
        type: "pkcs8",
    });
}

function publicKeyObject(raw: Buffer) {
    return createPublicKey({
        key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
        format: "der",
        type: "spki",
    });
}

/** Raw 32-byte X25519 public key for a raw private key. */
export function publicKeyFor(privateRaw: Buffer): Buffer {
    const der = createPublicKey(privateKeyObject(privateRaw)).export({
        format: "der",
        type: "spki",
    });
    return Buffer.from(der.subarray(der.length - 32));
}

/** A fresh MyData keypair, raw 32-byte halves. */
export function generateMyDataKeyPair(): { privateKey: Buffer; publicKey: Buffer } {
    const { privateKey } = generateKeyPairSync("x25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    const raw = Buffer.from(der.subarray(der.length - 32));
    return { privateKey: raw, publicKey: publicKeyFor(raw) };
}

function deriveKey(shared: Buffer, ephemeralPublic: Buffer, recipientPublic: Buffer): Buffer {
    return Buffer.from(
        hkdfSync(
            "sha256",
            shared,
            Buffer.concat([ephemeralPublic, recipientPublic]),
            HKDF_INFO,
            32,
        ),
    );
}

/**
 * MyData a 32-byte seed to a recipient. The bridge itself never encrypts; this exists
 * for tests and for operators scripting registration, and it is the reference
 * the browser implementation is checked against.
 */
export function encryptSeed(seed: Buffer, recipientPublic: Buffer, aad: Buffer): string {
    if (seed.length !== SEED_BYTES) throw new DelegateCryptoError("seed must be 32 bytes");
    const ephemeral = generateMyDataKeyPair();
    const shared = diffieHellman({
        privateKey: privateKeyObject(ephemeral.privateKey),
        publicKey: publicKeyObject(recipientPublic),
    });
    const key = deriveKey(shared, ephemeral.publicKey, recipientPublic);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(seed), cipher.final(), cipher.getAuthTag()]);
    return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), ephemeral.publicKey, iv, body]).toString(
        "base64url",
    );
}

/**
 * Open an envelope. Every failure collapses to one generic message: a caller
 * (or a log) learns "could not open", never which step failed or any bytes.
 */
export function decryptSeed(envelope: string, privateRaw: Buffer, aad: Buffer): Buffer {
    const fail = () => new DelegateCryptoError("encrypted delegate key could not be opened");
    let raw: Buffer;
    try {
        raw = Buffer.from(envelope, "base64url");
    } catch {
        throw fail();
    }
    // version + ephemeral public + iv + at least the 16-byte tag
    if (raw.length < 1 + 32 + 12 + 16 || raw[0] !== ENVELOPE_VERSION) throw fail();

    const ephemeralPublic = raw.subarray(1, 33);
    const iv = raw.subarray(33, 45);
    const body = raw.subarray(45);
    try {
        const recipientPublic = publicKeyFor(privateRaw);
        const shared = diffieHellman({
            privateKey: privateKeyObject(privateRaw),
            publicKey: publicKeyObject(Buffer.from(ephemeralPublic)),
        });
        const key = deriveKey(shared, Buffer.from(ephemeralPublic), recipientPublic);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(body.subarray(body.length - 16));
        const seed = Buffer.concat([
            decipher.update(body.subarray(0, body.length - 16)),
            decipher.final(),
        ]);
        if (seed.length !== SEED_BYTES) throw fail();
        return seed;
    } catch {
        throw fail();
    }
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** The bridge's MyData private key, by id, so a key can be rotated without downtime. */
export class MyDataKeyRing {
    private readonly keys = new Map<string, Buffer>();

    /** Parse `id:base64url,id2:base64url`. Throws without echoing any key text. */
    static parse(raw: string): MyDataKeyRing {
        const ring = new MyDataKeyRing();
        for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
            const at = part.indexOf(":");
            const id = at > 0 ? part.slice(0, at) : "";
            const value = at > 0 ? part.slice(at + 1) : "";
            if (!KEY_ID.test(id)) {
                throw new DelegateCryptoError(
                    "AUTOMATION_MYDATA_PRIVATE_KEYS entries must look like <id>:<base64url key>",
                );
            }
            const privateRaw = Buffer.from(value, "base64url");
            if (privateRaw.length !== 32) {
                throw new DelegateCryptoError(`AUTOMATION_MYDATA_PRIVATE_KEYS key "${id}" must be 32 bytes`);
            }
            ring.keys.set(id, privateRaw);
        }
        if (ring.keys.size === 0) {
            throw new DelegateCryptoError("AUTOMATION_MYDATA_PRIVATE_KEYS contains no keys");
        }
        return ring;
    }

    /** Public halves only. Safe to publish and to log. */
    publicKeys(): Array<{ id: string; publicKey: string }> {
        return [...this.keys.entries()].map(([id, priv]) => ({
            id,
            publicKey: publicKeyFor(priv).toString("base64url"),
        }));
    }

    open(keyId: string, envelope: string, aad: Buffer): Buffer {
        const priv = this.keys.get(keyId);
        if (!priv) throw new DelegateCryptoError("encrypted delegate key could not be opened");
        return decryptSeed(envelope, priv, aad);
    }
}
