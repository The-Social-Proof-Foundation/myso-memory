/** Named listing decryption. No agent/root signing keys, generic Move targets,
 * cached derived-key clients, or owner-policy fallback enter this boundary. */
import { createHash } from "node:crypto";
import { EncryptedObject, MyDataClient, SessionKey } from "@socialproof/mydata";
import { Transaction } from "@socialproof/myso/transactions";
import type { ClientWithCoreApi } from "@socialproof/myso/client";
import { describeKeyMismatch } from "./mydata-policy.js";

export class ListingAccessError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}
interface ListingInput {
    data: string; packageId: string; accountId: string; callerAddress: string;
    mydataId: string; encryptionIdHex: string; encryptedDataDigestHex: string;
    organizationId?: string; organizationMemoryGroupId?: string;
}
function id(value: unknown): string {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new ListingAccessError(400, "Invalid MyData policy identity");
    return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}
function input(value: unknown): ListingInput {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ListingAccessError(400, "Invalid listing request");
    const record = value as Record<string, unknown>;
    const required = ["data", "packageId", "accountId", "callerAddress", "mydataId", "encryptionIdHex", "encryptedDataDigestHex"];
    const optional = ["organizationId", "organizationMemoryGroupId"];
    if (Object.keys(record).some(key => ![...required, ...optional].includes(key))
        || required.some(key => typeof record[key] !== "string")
        || optional.some(key => record[key] !== undefined && typeof record[key] !== "string")) {
        throw new ListingAccessError(400, "Invalid listing request fields");
    }
    for (const name of ["packageId", "accountId", "callerAddress", "mydataId"]) id(record[name]);
    if ((record.organizationId === undefined) !== (record.organizationMemoryGroupId === undefined)) throw new ListingAccessError(400, "Organization audience identity is incomplete");
    if (record.organizationId !== undefined) { id(record.organizationId); id(record.organizationMemoryGroupId); }
    if (!/^(?:[0-9a-f]{2}){1,1024}$/.test(String(record.encryptionIdHex)) || !/^[0-9a-f]{64}$/.test(String(record.encryptedDataDigestHex))) throw new ListingAccessError(400, "Invalid listing data binding");
    if (String(record.data).length > 349528) throw new ListingAccessError(413, "Listing ciphertext is too large");
    return record as unknown as ListingInput;
}
export function addListingApproveCall(tx: Transaction, packageId: string, memoryConfigId: string, blockListId: string, accountId: string, mydataId: string, identity: string, organizationId?: string, organizationMemoryGroupId?: string): void {
    if (!/^(?:[0-9a-f]{2}){1,1024}$/.test(identity)) throw new ListingAccessError(400, "Invalid listing encryption identity");
    const orgAudience = organizationId !== undefined && organizationMemoryGroupId !== undefined;
    tx.moveCall({
        target: `${id(packageId)}::mydata::${orgAudience ? "mydata_approve_org_audience" : "mydata_approve"}`,
        arguments: [tx.pure("vector<u8>", Array.from(Buffer.from(identity, "hex"))), tx.object(id(blockListId)),
            tx.object(id(memoryConfigId)), tx.object(id(mydataId)), tx.object(id(accountId)),
            ...(orgAudience ? [tx.object(id(organizationId)), tx.object(id(organizationMemoryGroupId))] : []), tx.object("0x6")],
    });
}
export interface ListingDecryptDependencies {
    packageId: string; memoryConfigId: string; blockListId: string;
    mysoClient: ClientWithCoreApi;
    /** Fresh per-request client. Only public key-server discovery may be shared. */
    createClient(): Promise<{ client: MyDataClient; keyServerIds: string[] }>;
}
interface AuthorizedListing {
    client: MyDataClient;
    session: SessionKey;
    ciphertext: Buffer;
    txBytes: Uint8Array;
}
async function authorizeListing(value: unknown, sessionHeader: unknown, deps: ListingDecryptDependencies): Promise<AuthorizedListing> {
    const body = input(value);
    if (id(body.packageId) !== id(deps.packageId)) throw new ListingAccessError(403, "Listing package is outside this deployment");
    if (typeof sessionHeader !== "string" || sessionHeader.length > 16384) throw new ListingAccessError(401, "A current MyData session is required");
    let exported: Record<string, unknown>;
    try { exported = JSON.parse(Buffer.from(sessionHeader, "base64").toString("utf8")); }
    catch { throw new ListingAccessError(401, "Invalid MyData session"); }
    try {
        if (!exported || typeof exported !== "object" || Array.isArray(exported) || typeof exported.personalMessageSignature !== "string"
            || !exported.personalMessageSignature || id(exported.address) !== id(body.callerAddress)
            || id(exported.packageId) !== id(body.packageId)) throw new Error("session mismatch");
    } catch { throw new ListingAccessError(401, "MyData session does not match the authenticated caller"); }
    let session: SessionKey;
    try { session = SessionKey.import(exported as unknown as Parameters<typeof SessionKey.import>[0], deps.mysoClient); }
    catch { throw new ListingAccessError(401, "Invalid MyData session"); }
    if (session.isExpired()) throw new ListingAccessError(401, "MyData session has expired");
    const ciphertext = Buffer.from(body.data, "base64");
    if (!ciphertext.length || ciphertext.length > 262144 || ciphertext.toString("base64") !== body.data
        || createHash("sha256").update(ciphertext).digest("hex") !== body.encryptedDataDigestHex) throw new ListingAccessError(409, "Listing ciphertext does not match the requested version");
    let parsed: ReturnType<typeof EncryptedObject.parse>;
    try { parsed = EncryptedObject.parse(ciphertext); }
    catch { throw new ListingAccessError(415, "This listing does not use supported MyData threshold encryption"); }
    if (parsed.version !== 0 || parsed.ciphertext.$kind === "Plain") throw new ListingAccessError(415, "Unsupported listing content encryption");
    if (id(parsed.packageId) !== id(body.packageId) || parsed.id !== body.encryptionIdHex) throw new ListingAccessError(409, "Ciphertext encryption identity does not match its listing");
    const { client, keyServerIds } = await deps.createClient();
    if (describeKeyMismatch(parsed, session.getPackageId(), keyServerIds)) throw new ListingAccessError(409, "The configured key servers cannot open this listing");
    const tx = new Transaction();
    addListingApproveCall(tx, body.packageId, deps.memoryConfigId, deps.blockListId, body.accountId, body.mydataId, parsed.id, body.organizationId, body.organizationMemoryGroupId);
    const txBytes = await tx.build({ client: deps.mysoClient, onlyTransactionKind: true });
    // This client is fresh: fetchKeys cannot return an earlier cached authorization.
    try {
        await client.fetchKeys({ ids: [parsed.id], txBytes, sessionKey: session, threshold: parsed.threshold });
    } catch (error) {
        ciphertext.fill(0);
        throw error;
    }
    if (session.isExpired()) {
        ciphertext.fill(0);
        throw new ListingAccessError(403, "The content request could not be authorized");
    }
    return { client, session, ciphertext, txBytes };
}

/** Check present key-server authorization without decrypting or returning listing plaintext. */
export async function checkListingAccess(value: unknown, sessionHeader: unknown, deps: ListingDecryptDependencies): Promise<void> {
    const authorized = await authorizeListing(value, sessionHeader, deps);
    // Key shares and the caller session remain scoped to this fresh request client.
    // Discard the ciphertext immediately; no decrypted content is constructed.
    authorized.ciphertext.fill(0);
}

export async function decryptListing(value: unknown, sessionHeader: unknown, deps: ListingDecryptDependencies): Promise<Uint8Array> {
    const authorized = await authorizeListing(value, sessionHeader, deps);
    let plaintext: Uint8Array;
    try {
        plaintext = await authorized.client.decrypt({ data: authorized.ciphertext, sessionKey: authorized.session, txBytes: authorized.txBytes, checkShareConsistency: true });
    } finally {
        authorized.ciphertext.fill(0);
    }
    if (authorized.session.isExpired() || plaintext.length > 262144) {
        plaintext.fill(0);
        throw new ListingAccessError(403, "The content request could not be authorized");
    }
    return plaintext;
}
