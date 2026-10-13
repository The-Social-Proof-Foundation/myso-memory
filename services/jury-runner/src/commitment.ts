/**
 * The sealed vote's commitment, byte for byte what `jury::compute_commitment` hashes:
 * `sha3_256(bcs(case_id) ‖ bcs(round) ‖ bcs(agent_id) ‖ bcs(outcome) ‖ rationale_digest ‖
 * bcs(evidence_refs) ‖ bundle_digest ‖ salt)`. The digests and the salt are raw bytes, not BCS.
 *
 * `commitment.test.ts` pins this to the same reference vector as the Move test
 * `the_commitment_matches_the_reference_vector_the_runner_uses`.
 */

import { createHash, createHmac } from "node:crypto";

/** A Move `ID` or `address`: 32 bytes, left padded. */
export function bcsId(id: string): Buffer {
    const hex = id.trim().replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{1,64}$/.test(hex)) {
        throw new TypeError(`not an object id: ${JSON.stringify(id)}`);
    }
    return Buffer.from(hex.padStart(64, "0"), "hex");
}

export function bcsU64(value: number | bigint | string): Buffer {
    const big = BigInt(value);
    if (big < 0n || big > 0xffff_ffff_ffff_ffffn) {
        throw new RangeError("u64 out of range");
    }
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(big);
    return out;
}

export function bcsU8(value: number): Buffer {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError("u8 out of range");
    }
    return Buffer.from([value]);
}

function uleb128(value: number): Buffer {
    const bytes: number[] = [];
    let rest = value;
    do {
        let byte = rest & 0x7f;
        rest >>>= 7;
        if (rest !== 0) byte |= 0x80;
        bytes.push(byte);
    } while (rest !== 0);
    return Buffer.from(bytes);
}

export function bcsU64Vector(values: readonly (number | bigint | string)[]): Buffer {
    return Buffer.concat([uleb128(values.length), ...values.map(bcsU64)]);
}

export function hexBytes(hex: string, label: string, length?: number): Buffer {
    if (!/^([0-9a-f]{2})*$/.test(hex)) {
        throw new TypeError(`${label} must be lowercase hex`);
    }
    const bytes = Buffer.from(hex, "hex");
    if (length !== undefined && bytes.length !== length) {
        throw new TypeError(`${label} must be ${length} bytes`);
    }
    return bytes;
}

export interface CommitmentInput {
    caseId: string;
    round: number;
    agentId: string;
    outcome: number;
    rationaleDigestHex: string;
    evidenceRefs: readonly number[];
    bundleDigestHex: string;
    saltHex: string;
}

export function computeCommitment(input: CommitmentInput): string {
    const preimage = Buffer.concat([
        bcsId(input.caseId),
        bcsU64(input.round),
        bcsId(input.agentId),
        bcsU8(input.outcome),
        hexBytes(input.rationaleDigestHex, "rationaleDigestHex", 32),
        bcsU64Vector(input.evidenceRefs),
        hexBytes(input.bundleDigestHex, "bundleDigestHex", 32),
        hexBytes(input.saltHex, "saltHex", 16),
    ]);
    return createHash("sha3-256").update(preimage).digest("hex");
}

/**
 * The salt is derived, not stored, so a restarted runner reveals the same vote it committed:
 * `HMAC-SHA256(secret, case ‖ round ‖ agent ‖ "salt")` cut to 16 bytes. Without the secret the
 * salt cannot be recomputed, which is what keeps the sealed outcome from being guessed from its
 * commitment (there are only a few outcomes to try).
 */
export function deriveSalt(secret: string, caseId: string, round: number, agentId: string): string {
    return createHmac("sha256", secret)
        .update(Buffer.concat([bcsId(caseId), bcsU64(round), bcsId(agentId), Buffer.from("salt")]))
        .digest()
        .subarray(0, 16)
        .toString("hex");
}

export function sha256Hex(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}
