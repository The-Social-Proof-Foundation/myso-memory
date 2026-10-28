import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import { createHash } from "node:crypto";
import { Signer, type SignatureScheme, type SignatureWithBytes } from "@socialproof/myso/cryptography";
import { Ed25519PublicKey } from "@socialproof/myso/keypairs/ed25519";
import { verifyPersonalMessageSignature } from "@socialproof/myso/verify";
import { AgentMyDataReaderPolicy, createMySoMessagingStackClient, messagingPermissionTypes, resolveGenesisMessagingConfig, type GroupRef } from "@socialproof/myso-messaging-stack";
import { CAP_MESSAGE_READ, CAP_MESSAGE_SEND } from "@socialproof/sub-agents";
import { McpRuntimeError } from "./errors.js";
import type { AgentSigner } from "./signers.js";
import type { RoomHistoryClient } from "./social-gateway.js";

type AgentContext = {
    owner: string;
    memoryAccountId: string;
    agentObjectId: string;
    derivedAddress: string;
    capabilities: number;
    platformScope?: string | null;
    network: "mainnet" | "testnet" | "devnet" | "localnet";
    rpcUrl: string;
    socialChain: Record<string, unknown> & { packageId: string; memoryConfigId: string; platformObjectId?: string };
};

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated agent context is invalid.");
    return value as Record<string, unknown>;
}

function address(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The authenticated agent context has an invalid ${label}.`);
    return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

function parseContext(value: unknown): AgentContext {
    const context = record(value);
    const network = context.network;
    if (network !== "mainnet" && network !== "testnet" && network !== "devnet" && network !== "localnet") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent context network is invalid.");
    const rpcUrl = context.rpcUrl;
    if (typeof rpcUrl !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent context RPC URL is missing.");
    let parsed: URL;
    try { parsed = new URL(rpcUrl); } catch { throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent context RPC URL is invalid."); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent context RPC URL is invalid.");
    const chain = record(context.socialChain);
    const capabilities = context.capabilities;
    if (!Number.isSafeInteger(capabilities) || Number(capabilities) < 0) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent context capabilities are invalid.");
    return {
        owner: address(context.owner, "owner address"),
        memoryAccountId: address(context.memoryAccountId, "Memory account ID"),
        agentObjectId: address(context.agentObjectId, "agent object ID"),
        derivedAddress: address(context.derivedAddress, "derived address"),
        capabilities: Number(capabilities),
        platformScope: context.platformScope === null || context.platformScope === undefined ? context.platformScope as null | undefined : address(context.platformScope, "platform scope"),
        network,
        rpcUrl: parsed.toString().replace(/\/$/, ""),
        socialChain: {
            ...chain,
            packageId: address(chain.packageId, "social package ID"),
            memoryConfigId: address(chain.memoryConfigId, "Memory config ID"),
            platformObjectId: typeof chain.platformObjectId === "string" ? address(chain.platformObjectId, "platform object ID") : undefined,
        },
    };
}

function hasCapability(context: AgentContext, capability: number): boolean {
    return (context.capabilities & capability) === capability;
}

function sha256Hex(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function attachmentIdempotencyKey(bytes: Uint8Array): string {
    const id = createHash("sha256").update(bytes).digest().subarray(0, 16);
    const normalized = Buffer.from(id);
    normalized[6] = (normalized[6]! & 0x0f) | 0x50;
    normalized[8] = (normalized[8]! & 0x3f) | 0x80;
    const hex = normalized.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storageRefMatchesGroup(storageId: string, groupId: string): boolean {
    const match = /^r2room:\/\/(0x)?([0-9a-fA-F]{1,64})\/[0-9a-fA-F-]{36}$/i.exec(storageId);
    return Boolean(match && address(`0x${match[2]}`, "attachment room ID") === address(groupId, "room ID"));
}

/** Adapts the existing session-bound agent signer to the SDK's personal-message signer API. */
class McpAgentMessagingSigner extends Signer {
    constructor(private readonly agentSigner: AgentSigner, private readonly publicKey: Ed25519PublicKey) { super(); }
    override async sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
        const signature = await this.agentSigner.sign(bytes);
        const result = new Uint8Array(signature.byteLength);
        result.set(signature);
        return result;
    }
    override getKeyScheme(): SignatureScheme { return "ED25519"; }
    override getPublicKey(): Ed25519PublicKey { return this.publicKey; }
    override async signAndExecuteTransaction(_options: Parameters<Signer["signAndExecuteTransaction"]>[0]): Promise<Awaited<ReturnType<Signer["signAndExecuteTransaction"]>>> {
        throw new McpRuntimeError("CAPABILITY_DENIED", "Room relayer operations cannot submit chain transactions through this signer adapter.");
    }
}

/** Transaction-capable adapter used only by the explicit atomic member-removal/key-rotation tool. */
class McpRoomAdminSigner extends McpAgentMessagingSigner {
    constructor(private readonly transactionAgentSigner: AgentSigner, publicKey: Ed25519PublicKey) { super(transactionAgentSigner, publicKey); }

    override async signTransaction(bytes: Uint8Array): Promise<SignatureWithBytes> {
        const signature = await this.transactionAgentSigner.signTransaction(bytes.slice());
        if (typeof signature !== "string" || !signature) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The agent transaction signer returned no signature.");
        return { signature, bytes: Buffer.from(bytes).toString("base64") };
    }

    override async signAndExecuteTransaction(options: Parameters<Signer["signAndExecuteTransaction"]>[0]): Promise<Awaited<ReturnType<Signer["signAndExecuteTransaction"]>>> {
        const client = options.client as unknown as MySoJsonRpcClient;
        const response = await client.signAndExecuteTransaction({ transaction: options.transaction, signer: this, options: { showEffects: true, showEvents: true } });
        return response as unknown as Awaited<ReturnType<Signer["signAndExecuteTransaction"]>>;
    }
}

/**
 * Fresh per-call MyData/DEK client for MCP room operations. Every operation obtains
 * the signed agent context again and checks the exact room permission on chain.
 */
export class McpRoomMessagingClient implements RoomHistoryClient {
    private readonly getContext: () => Promise<unknown>;
    constructor(
        private readonly signer: AgentSigner,
        private readonly relayerUrl: string,
        getAgentContext: () => Promise<unknown>,
        private readonly signedJson?: (method: "POST", path: string, body: object) => Promise<unknown>,
    ) {
        this.getContext = getAgentContext;
        let parsed: URL;
        try { parsed = new URL(relayerUrl); } catch { throw new McpRuntimeError("INVALID_CONFIGURATION", "The messaging relayer URL is invalid."); }
        if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw new McpRuntimeError("INVALID_CONFIGURATION", "The messaging relayer must use HTTPS, except for loopback development.");
    }

    getAgentContext(): Promise<unknown> { return this.getContext(); }

    private async createClient(permission: "read" | "send", transactionSigner = false) {
        const context = parseContext(await this.getContext());
        const capability = permission === "read" ? CAP_MESSAGE_READ : CAP_MESSAGE_SEND;
        if (!hasCapability(context, capability)) throw new McpRuntimeError("CAPABILITY_DENIED", `The agent lacks Messaging${permission === "read" ? "Reader" : "Sender"} capability.`);
        const signerAddress = address(await this.signer.getMySoAddress(), "signer address");
        if (signerAddress !== context.derivedAddress) throw new McpRuntimeError("AUTHENTICATION_FAILED", "The room signer does not match the authenticated agent.");
        const publicKeyBytes = await this.signer.getPublicKey();
        if (publicKeyBytes.byteLength !== 32) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "Room messaging requires an Ed25519 agent key.");
        const publicKey = new Ed25519PublicKey(publicKeyBytes);
        const sdkSigner = transactionSigner ? new McpRoomAdminSigner(this.signer, publicKey) : new McpAgentMessagingSigner(this.signer, publicKey);
        const baseClient = new MySoJsonRpcClient({ url: context.rpcUrl, network: context.network });
        const genesis = await resolveGenesisMessagingConfig(baseClient, { rpcUrl: context.rpcUrl });
        const chain = context.socialChain;
        const messagingPackageConfig = {
            ...genesis.messaging,
            latestPackageId: typeof chain.messagingPackageId === "string" ? address(chain.messagingPackageId, "messaging package ID") : genesis.messaging.latestPackageId,
            versionId: typeof chain.messagingVersionId === "string" ? address(chain.messagingVersionId, "messaging version ID") : genesis.messaging.versionId,
            memoryConfigId: genesis.messaging.memoryConfigId,
            messagingConfigId: typeof chain.messagingConfigId === "string" ? address(chain.messagingConfigId, "messaging config ID") : genesis.messaging.messagingConfigId,
            namespaceId: typeof chain.messagingNamespaceId === "string" ? address(chain.messagingNamespaceId, "messaging namespace ID") : genesis.messaging.namespaceId,
        };
        const platformId = context.platformScope ?? context.socialChain.platformObjectId;
        if (!platformId) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent context has no platform object for native room authorization.");
        const packageConfig = { ...genesis, messaging: messagingPackageConfig };
        const attachments = this.signedJson ? {
            storageAdapter: {
                upload: async (entries: Array<{ name: string; data: Uint8Array }>, uploadContext?: { groupRef: { groupId: string; encryptionHistoryId: string } }) => {
                    const groupId = uploadContext?.groupRef.groupId;
                    if (!groupId || !/^0x[0-9a-fA-F]{1,64}$/.test(groupId) || !entries.length || entries.length > 10) throw new McpRuntimeError("INVALID_ARGUMENT", "Room attachment upload requires a resolved room and 1–10 files.");
                    const ids: string[] = [];
                    for (const entry of entries) {
                        if (!(entry.data instanceof Uint8Array) || entry.data.byteLength < 1 || entry.data.byteLength > 5 * 1024 * 1024) throw new McpRuntimeError("INVALID_ARGUMENT", "Encrypted attachments must contain 1–5 MiB of bytes.");
                        const contentBase64 = Buffer.from(entry.data).toString("base64");
                        const idempotencyKey = attachmentIdempotencyKey(entry.data);
                        const value = record(await this.signedJson!("POST", "/api/messaging/attachments/upload", { groupId, contentBase64, idempotencyKey }));
                        const storageId = value.storageId;
                        if (Object.keys(value).sort().join(",") !== "ciphertextOnly,contentLength,groupId,idempotentReplay,sha256Hex,storage,storageId"
                            || value.groupId !== groupId || typeof storageId !== "string" || !storageRefMatchesGroup(storageId, groupId)
                            || value.contentLength !== entry.data.byteLength || value.sha256Hex !== sha256Hex(entry.data)
                            || value.storage !== "cloudflare_r2" || value.ciphertextOnly !== true || typeof value.idempotentReplay !== "boolean") {
                            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "R2 upload confirmation does not match the encrypted attachment.");
                        }
                        ids.push(storageId);
                    }
                    return { ids, metadata: { storage: "cloudflare_r2" } };
                },
                download: async (storageId: string) => {
                    if (!storageId || !/^r2room:\/\/(?:0x)?[0-9a-fA-F]{1,64}\/[0-9a-f-]{36}$/i.test(storageId)) throw new McpRuntimeError("INVALID_ARGUMENT", "storageId is not a valid R2 room attachment reference.");
                    const value = record(await this.signedJson!("POST", "/api/messaging/attachments/download", { storageId }));
                    if (Object.keys(value).sort().join(",") !== "ciphertextOnly,contentBase64,contentLength,groupId,sha256Hex,storage,storageId"
                        || value.storageId !== storageId || typeof value.groupId !== "string" || !storageRefMatchesGroup(storageId, value.groupId)
                        || typeof value.contentBase64 !== "string" || !value.contentBase64
                        || value.storage !== "cloudflare_r2" || value.ciphertextOnly !== true) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "R2 returned an invalid encrypted attachment response.");
                    const bytes = Buffer.from(value.contentBase64, "base64");
                    if (bytes.toString("base64") !== value.contentBase64 || !bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024
                        || value.contentLength !== bytes.byteLength || value.sha256Hex !== sha256Hex(bytes)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The downloaded R2 attachment failed its length or digest check.");
                    return new Uint8Array(bytes);
                },
            },
            maxAttachments: 10,
            maxFileSizeBytes: 5 * 1024 * 1024 - 16,
            maxTotalFileSizeBytes: 50 * 1024 * 1024,
        } : undefined;
        const client = createMySoMessagingStackClient(baseClient, {
            mydata: { serverConfigs: [], verifyKeyServers: false },
            encryption: {
                sessionKey: { signer: sdkSigner },
                mydataPolicy: new AgentMyDataReaderPolicy({
                    originalPackageId: messagingPackageConfig.originalPackageId,
                    latestPackageId: messagingPackageConfig.latestPackageId,
                    versionId: messagingPackageConfig.versionId,
                    platformId,
                    memoryConfigId: messagingPackageConfig.memoryConfigId,
                    memoryAccountId: context.memoryAccountId,
                    agentDerivedAddress: context.derivedAddress,
                }),
            },
            packageConfig,
            relayer: { relayerUrl: this.relayerUrl },
            ...(attachments ? { attachments } : {}),
        });
        return { client, signer: sdkSigner, context, permissionedGroupsPackageId: genesis.permissionedGroups.originalPackageId, baseClient };
    }

    private async assertRoomPermission(client: Awaited<ReturnType<McpRoomMessagingClient["createClient"]>>["client"], signer: McpAgentMessagingSigner, groupRef: GroupRef, permission: "MessagingReader" | "MessagingSender"): Promise<void> {
        const groupId = client.messaging.derive.resolveGroupRef(groupRef).groupId;
        await this.assertRoomIdPermission(client, signer, groupId, permission);
    }

    private async hasRoomIdPermission(client: Awaited<ReturnType<McpRoomMessagingClient["createClient"]>>["client"], signer: McpAgentMessagingSigner, groupId: string, permission: "MessagingReader" | "MessagingSender"): Promise<boolean> {
        return client.groups.view.hasPermission({ groupId: address(groupId, "room ID"), member: signer.toMySoAddress(), permissionType: messagingPermissionTypes(client.messaging.packageConfig.originalPackageId)[permission] });
    }

    private async assertRoomIdPermission(client: Awaited<ReturnType<McpRoomMessagingClient["createClient"]>>["client"], signer: McpAgentMessagingSigner, groupId: string, permission: "MessagingReader" | "MessagingSender"): Promise<void> {
        const allowed = await this.hasRoomIdPermission(client, signer, groupId, permission);
        if (!allowed) throw new McpRuntimeError("CAPABILITY_DENIED", `The agent lacks live ${permission} permission on this room.`);
    }

    async listRoomConversations(request: { limit?: number; offset?: number; afterGroupId?: string }): Promise<unknown> {
        const { client, signer } = await this.createClient("read");
        const limit = request.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new McpRuntimeError("INVALID_ARGUMENT", "limit must be between 1 and 100.");
        const offset = request.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new McpRuntimeError("INVALID_ARGUMENT", "offset must be a nonnegative safe integer.");
        if (offset > Number.MAX_SAFE_INTEGER - limit) throw new McpRuntimeError("INVALID_ARGUMENT", "offset plus limit must remain a safe integer.");
        if (request.afterGroupId !== undefined && request.offset !== undefined) throw new McpRuntimeError("INVALID_ARGUMENT", "Use either afterGroupId or offset, not both.");
        const afterGroupId = request.afterGroupId === undefined ? undefined : address(request.afterGroupId, "room cursor");
        // Fetch one look-ahead row so callers can distinguish the last page.
        // Advance by the raw index page, never by the permission-filtered rows;
        // otherwise a page containing stale membership entries can cause skips.
        const indexedGroupIds = await client.messaging.transport.listMemberConversations({ signer, limit: limit + 1, ...(afterGroupId ? { afterGroupId } : { offset }) });
        if (!Array.isArray(indexedGroupIds) || indexedGroupIds.length > limit + 1 || indexedGroupIds.some((id) => typeof id !== "string")) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The messaging relayer returned an invalid room discovery page.");
        const hasMore = indexedGroupIds.length > limit;
        const groupIds = indexedGroupIds.slice(0, limit);
        const permittedIds: string[] = [];
        for (const rawGroupId of groupIds) {
            const groupId = address(rawGroupId, "room ID");
            if (await this.hasRoomIdPermission(client, signer, groupId, "MessagingReader")) permittedIds.push(groupId);
        }
        const metadata = permittedIds.length ? await client.messaging.view.groupsMetadata({ groupIds: permittedIds, refresh: true }) : {};
        const conversations: { groupId: string; groupName?: string; groupUuid?: string; creatorPrincipal?: string }[] = [];
        for (const groupId of permittedIds) {
            // Permission is checked again after metadata retrieval so a concurrent
            // removal cannot turn stale index data into a disclosed room row.
            if (!await this.hasRoomIdPermission(client, signer, groupId, "MessagingReader")) continue;
            const row = metadata[groupId];
            conversations.push({
                groupId,
                ...(row ? { groupName: row.name, groupUuid: row.uuid, creatorPrincipal: row.creator } : {}),
            });
        }
        return {
            conversations,
            offset: afterGroupId ? null : offset,
            limit,
            hasMore,
            nextOffset: hasMore && !afterGroupId ? offset + limit : null,
            afterGroupId: afterGroupId ?? null,
            nextAfterGroupId: hasMore ? address(groupIds[groupIds.length - 1], "room cursor") : null,
            membershipSource: "relayer_membership_index",
            permissionSource: "live_fullnode_messaging_reader_checked",
            metadataSource: "configured_fullnode_group_metadata",
        };
    }

    async getRoomReadState(): Promise<unknown> {
        const { client, signer } = await this.createClient("read");
        return client.messaging.getReadState({ signer });
    }

    async updateRoomReadState(request: { groupId: string; readUpto: number }): Promise<unknown> {
        const { client, signer } = await this.createClient("read");
        const groupId = address(request.groupId, "room ID");
        if (!Number.isSafeInteger(request.readUpto) || request.readUpto < 0) throw new McpRuntimeError("INVALID_ARGUMENT", "readUpto must be a nonnegative safe integer.");
        await this.assertRoomIdPermission(client, signer, groupId, "MessagingReader");
        const state = await client.messaging.updateReadState({ signer, groupId, readUpto: request.readUpto });
        await this.assertRoomIdPermission(client, signer, groupId, "MessagingReader");
        return state;
    }

    async getRoomUnreadCounts(request: { groupIds: string[] }): Promise<unknown> {
        const { client, signer } = await this.createClient("read");
        if (!Array.isArray(request.groupIds) || request.groupIds.length < 1 || request.groupIds.length > 50) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide 1–50 room IDs.");
        const groupIds = request.groupIds.map((groupId) => address(groupId, "room ID"));
        if (new Set(groupIds).size !== groupIds.length) throw new McpRuntimeError("INVALID_ARGUMENT", "Room IDs must be unique.");
        await Promise.all(groupIds.map((groupId) => this.assertRoomIdPermission(client, signer, groupId, "MessagingReader")));
        const counts = await client.messaging.getUnreadCounts({ signer, groupIds });
        await Promise.all(groupIds.map((groupId) => this.assertRoomIdPermission(client, signer, groupId, "MessagingReader")));
        return counts;
    }

    async sendRoomMessage(request: { groupRef: GroupRef; text?: string; files?: Array<{ fileName: string; mimeType: string; contentBase64: string }>; idempotencyKey: string }): Promise<unknown> {
        const { client, signer } = await this.createClient("send");
        const groupId = client.messaging.derive.resolveGroupRef(request.groupRef).groupId;
        const text = request.text ?? "";
        if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 64 * 1024) throw new McpRuntimeError("INVALID_ARGUMENT", "Room message text may contain at most 65,536 UTF-8 bytes.");
        if (!text.trim() && (!Array.isArray(request.files) || request.files.length === 0)) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide nonempty text or at least one attachment.");
        if (typeof request.idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.idempotencyKey)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "idempotencyKey must be a canonical UUID v4.");
        }
        const files = (request.files ?? []).map((file) => {
            if (!file || typeof file.fileName !== "string" || !file.fileName.trim() || file.fileName.length > 255
                || typeof file.mimeType !== "string" || !file.mimeType.trim() || file.mimeType.length > 128
                || typeof file.contentBase64 !== "string" || !file.contentBase64) throw new McpRuntimeError("INVALID_ARGUMENT", "Each attachment requires a filename, MIME type and base64 content.");
            const data = Buffer.from(file.contentBase64, "base64");
            if (data.toString("base64") !== file.contentBase64 || !data.byteLength || data.byteLength > 5 * 1024 * 1024 - 16) throw new McpRuntimeError("INVALID_ARGUMENT", "Attachments must be canonical base64 containing 1–5 MiB less encryption overhead.");
            return { fileName: file.fileName, mimeType: file.mimeType, data: new Uint8Array(data) };
        });
        if (files.length > 10 || files.reduce((size, file) => size + file.data.byteLength, 0) > 50 * 1024 * 1024) throw new McpRuntimeError("INVALID_ARGUMENT", "Room messages support at most 10 attachments and 50 MiB total file data.");
        if (files.length && !this.signedJson) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "Authenticated R2 storage is not configured for this MCP room client.");
        await this.assertRoomIdPermission(client, signer, groupId, "MessagingSender");
        const sent = await client.messaging.sendMessage({ signer, groupRef: request.groupRef, text, ...(files.length ? { files } : {}), idempotencyKey: request.idempotencyKey });
        if (!sent || typeof sent.messageId !== "string" || !sent.messageId) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The messaging relayer did not return a message ID.");
        }
        const message = await client.messaging.getMessage({ signer, groupRef: request.groupRef, messageId: sent.messageId });
        await this.assertRoomIdPermission(client, signer, groupId, "MessagingSender");
        if (message.groupId !== groupId || message.messageId !== sent.messageId || message.isDeleted || !message.senderVerified
            || address(message.senderAddress, "message sender") !== signer.toMySoAddress()
            || message.text !== text || message.attachments.length !== files.length
            || message.attachmentIntegrity !== (files.length ? "verified" : "none")) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The sent room message could not be confirmed by a verified caller-bound readback.");
        }
        return {
            messageId: message.messageId,
            groupId,
            order: message.order,
            senderAddress: address(message.senderAddress, "message sender"),
            textSha256: createHash("sha256").update(message.text, "utf8").digest("hex"),
            attachmentCount: message.attachments.length,
            attachmentIntegrity: message.attachmentIntegrity,
            signatureVerified: true,
            permissionSource: "live_fullnode_messaging_sender_checked_before_and_after",
            contentSource: "relayer_readback_signature_verified",
        };
    }

    async readRoomHistory(request: { groupRef: GroupRef; afterOrder?: number; beforeOrder?: number; limit?: number }): Promise<unknown> {
        const { client, signer } = await this.createClient("read");
        const page = await client.messaging.getRoomMessages({ signer, ...request });
        return page;
    }

    async readRoomAttachment(request: { groupRef: GroupRef; messageId: string; storageId: string }): Promise<unknown> {
        if (typeof request.messageId !== "string" || request.messageId.length < 1 || request.messageId.length > 256
            || typeof request.storageId !== "string" || request.storageId.length > 512) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "A valid messageId and attachment storageId are required.");
        }
        const { client, signer } = await this.createClient("read");
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingReader");
        const message = await client.messaging.getMessage({ signer, groupRef: request.groupRef, messageId: request.messageId });
        if (!message.senderVerified || message.attachmentIntegrity !== "verified" || message.isDeleted) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "Attachment plaintext is available only from a verified, undeleted signed room message.");
        }
        const attachment = message.attachments.find((item) => item.wire.storageId === request.storageId);
        if (!attachment) throw new McpRuntimeError("INVALID_ARGUMENT", "The selected attachment is not part of this verified room message.");
        if (!Number.isSafeInteger(attachment.fileSize) || attachment.fileSize < 0 || attachment.fileSize > 5 * 1024 * 1024) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "This attachment exceeds the 5 MiB plaintext limit.");
        }
        const bytes = await attachment.data();
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingReader");
        if (bytes.byteLength !== attachment.fileSize) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Decrypted attachment size does not match its signed metadata.");
        return {
            messageId: message.messageId,
            groupId: message.groupId,
            order: message.order,
            storageId: request.storageId,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            fileSize: bytes.byteLength,
            contentBase64: Buffer.from(bytes).toString("base64"),
            contentSha256: sha256Hex(bytes),
            senderVerified: true,
            attachmentIntegrity: "verified",
            permissionSource: "live_fullnode_messaging_reader_checked_before_and_after",
        };
    }

    private async getOwnedMessage(
        client: Awaited<ReturnType<McpRoomMessagingClient["createClient"]>>["client"],
        signer: McpAgentMessagingSigner,
        groupRef: GroupRef,
        messageId: string,
    ) {
        await this.assertRoomPermission(client, signer, groupRef, "MessagingSender");
        const message = await client.messaging.getMessage({ signer, groupRef, messageId });
        await this.assertRoomPermission(client, signer, groupRef, "MessagingSender");
        if (!message.senderVerified || address(message.senderAddress, "message sender") !== address(signer.toMySoAddress(), "agent signer") || message.isDeleted) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "Only the authenticated agent may change its own verified, undeleted room message.");
        }
        return message;
    }

    async editRoomMessage(request: { groupRef: GroupRef; messageId: string; text: string }): Promise<unknown> {
        const { client, signer } = await this.createClient("send");
        const before = await this.getOwnedMessage(client, signer, request.groupRef, request.messageId);
        await client.messaging.editMessage({ signer, groupRef: request.groupRef, messageId: request.messageId, text: request.text });
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingSender");
        const after = await client.messaging.getMessage({ signer, groupRef: request.groupRef, messageId: request.messageId });
        if (!after.senderVerified || address(after.senderAddress, "message sender") !== address(signer.toMySoAddress(), "agent signer") || after.isDeleted || !after.isEdited || after.text !== request.text) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The relayer accepted an edit, but the updated signed message could not be verified.");
        }
        return { updated: true, messageId: request.messageId, groupId: before.groupId, order: after.order, updatedAt: after.updatedAt, verification: "signed_message_refetched", source: "messaging_relayer" };
    }

    async deleteRoomMessage(request: { groupRef: GroupRef; messageId: string }): Promise<unknown> {
        const { client, signer } = await this.createClient("send");
        const before = await this.getOwnedMessage(client, signer, request.groupRef, request.messageId);
        await client.messaging.deleteMessage({ signer, groupRef: request.groupRef, messageId: request.messageId });
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingSender");
        const after = await client.messaging.getMessage({ signer, groupRef: request.groupRef, messageId: request.messageId });
        if (!after.isDeleted || address(after.senderAddress, "message sender") !== address(signer.toMySoAddress(), "agent signer")) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The relayer accepted deletion, but the matching sender-owned tombstone could not be verified.");
        }
        return { deleted: true, messageId: request.messageId, groupId: before.groupId, order: after.order, updatedAt: after.updatedAt, verification: "sender_owned_tombstone_refetched", source: "messaging_relayer" };
    }

    async removeRoomMembersAndRotateKey(request: { groupRef: GroupRef; members: string[] }): Promise<unknown> {
        const { client, signer, permissionedGroupsPackageId } = await this.createClient("send", true);
        const groupId = client.messaging.derive.resolveGroupRef(request.groupRef).groupId;
        if (!Array.isArray(request.members) || request.members.length < 1 || request.members.length > 50) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide between 1 and 50 room members to remove.");
        const members = request.members.map((member) => address(member, "member address"));
        if (new Set(members).size !== members.length) throw new McpRuntimeError("INVALID_ARGUMENT", "Member addresses must be unique.");
        const actor = address(signer.toMySoAddress(), "agent signer");
        if (members.includes(actor)) throw new McpRuntimeError("INVALID_ARGUMENT", "The acting agent cannot remove itself in the same key-rotation operation.");
        const types = messagingPermissionTypes(client.messaging.packageConfig.originalPackageId);
        const permissionsAdmin = `${permissionedGroupsPackageId}::permissioned_group::PermissionsAdmin`;
        await this.assertRoomIdPermission(client, signer, groupId, "MessagingReader");
        if (!(await client.groups.view.hasPermission({ groupId, member: actor, permissionType: permissionsAdmin }))) throw new McpRuntimeError("CAPABILITY_DENIED", "The agent requires live PermissionsAdmin authority on this room.");
        if (!(await client.groups.view.hasPermission({ groupId, member: actor, permissionType: types.EncryptionKeyRotator }))) throw new McpRuntimeError("CAPABILITY_DENIED", "The agent requires live EncryptionKeyRotator authority on this room.");
        for (const member of members) {
            if (!(await client.groups.view.hasPermission({ groupId, member, permissionType: types.MessagingReader }))) throw new McpRuntimeError("INVALID_ARGUMENT", "Every removal target must currently have MessagingReader permission on this room.");
        }
        const { encryptionHistoryId } = client.messaging.derive.resolveGroupRef(request.groupRef);
        const beforeKeyVersion = await client.messaging.view.getCurrentKeyVersion({ encryptionHistoryId });
        const transaction = await client.messaging.removeMembersAndRotateKey({ signer, groupId, encryptionHistoryId, members });
        try {
            await this.assertRoomIdPermission(client, signer, groupId, "MessagingReader");
            const afterKeyVersion = await client.messaging.view.getCurrentKeyVersion({ encryptionHistoryId });
            if (afterKeyVersion <= beforeKeyVersion) throw new Error("The room key version did not advance.");
            for (const member of members) {
                if (await client.groups.view.isMember({ groupId, member })) throw new Error("A removal target still has room membership.");
            }
            return { groupId, digest: transaction.digest, removedMembers: members, keyVersionBefore: beforeKeyVersion.toString(), keyVersionAfter: afterKeyVersion.toString(), verification: "finalized_membership_and_key_version", source: "myso_fullnode" };
        } catch (error) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `Transaction ${transaction.digest} finalized, but post-transaction membership or key-rotation verification failed. Reconcile the transaction digest before retrying.`, { digest: transaction.digest, retryable: false, cause: error });
        }
    }

    async addRoomMembers(request: { groupRef: GroupRef; members: string[]; acknowledgeHistoryAccess: true }): Promise<unknown> {
        const { client, signer, permissionedGroupsPackageId, baseClient } = await this.createClient("send", true);
        const groupId = client.messaging.derive.resolveGroupRef(request.groupRef).groupId;
        if (request.acknowledgeHistoryAccess !== true) throw new McpRuntimeError("INVALID_ARGUMENT", "Explicitly acknowledge that every invited wallet can access existing and future room history.");
        if (!Array.isArray(request.members) || request.members.length < 1 || request.members.length > 50) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide between 1 and 50 room members to invite.");
        const members = request.members.map((member) => address(member, "member address"));
        if (new Set(members).size !== members.length) throw new McpRuntimeError("INVALID_ARGUMENT", "Member addresses must be unique.");
        const actor = address(signer.toMySoAddress(), "agent signer");
        if (members.includes(actor)) throw new McpRuntimeError("INVALID_ARGUMENT", "The acting agent cannot invite itself.");
        const permissions = messagingPermissionTypes(client.messaging.packageConfig.originalPackageId);
        const extensionAdmin = `${permissionedGroupsPackageId}::permissioned_group::ExtensionPermissionsAdmin`;
        await this.assertRoomIdPermission(client, signer, groupId, "MessagingReader");
        if (!(await client.groups.view.hasPermission({ groupId, member: actor, permissionType: extensionAdmin }))) throw new McpRuntimeError("CAPABILITY_DENIED", "The agent requires live ExtensionPermissionsAdmin authority to invite readers.");
        const grants = await Promise.all(members.map(async (member) => {
            const [hasReader, hasSender] = await Promise.all([
                client.groups.view.hasPermission({ groupId, member, permissionType: permissions.MessagingReader }),
                client.groups.view.hasPermission({ groupId, member, permissionType: permissions.MessagingSender }),
            ]);
            return { address: member, permissions: [...(!hasReader ? [permissions.MessagingReader] : []), ...(!hasSender ? [permissions.MessagingSender] : [])] };
        }));
        const grantsToAdd = grants.filter((entry) => entry.permissions.length > 0);
        if (grantsToAdd.length === 0) return { groupId, digest: null, grantedMembers: members, verification: "already_had_reader_and_sender_permissions", source: "myso_fullnode" };
        let digest = "";
        try {
            const submitted = await client.groups.addMembers({ signer, groupId, members: grantsToAdd });
            digest = submitted.digest;
            await baseClient.waitForTransaction({ digest, timeout: 60_000, pollInterval: 1_000 });
            await this.assertRoomIdPermission(client, signer, groupId, "MessagingReader");
            for (const member of members) {
                const [hasReader, hasSender] = await Promise.all([
                    client.groups.view.hasPermission({ groupId, member, permissionType: permissions.MessagingReader }),
                    client.groups.view.hasPermission({ groupId, member, permissionType: permissions.MessagingSender }),
                ]);
                if (!hasReader || !hasSender) throw new Error(`Recipient ${member} lacks a finalized reader or sender permission.`);
            }
            return { groupId, digest, grantedMembers: members, verification: "finalized_reader_and_sender_permissions", source: "myso_fullnode" };
        } catch (error) {
            if (error instanceof McpRuntimeError) throw error;
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", digest ? `Room invite transaction ${digest} finalized or submitted, but fullnode permission verification failed.` : "Room member invitation could not be submitted.", { digest: digest || undefined, retryable: false, cause: error });
        }
    }

    async leaveRoom(request: { groupRef: GroupRef }): Promise<unknown> {
        const { client, signer, permissionedGroupsPackageId, baseClient } = await this.createClient("send", true);
        const groupId = client.messaging.derive.resolveGroupRef(request.groupRef).groupId;
        const actor = address(signer.toMySoAddress(), "agent signer");
        if (!(await client.groups.view.isMember({ groupId, member: actor }))) {
            return { left: true, groupId, digest: null, verification: "already_absent_from_membership", source: "myso_fullnode" };
        }
        const permissionsAdmin = `${permissionedGroupsPackageId}::permissioned_group::PermissionsAdmin`;
        if (await client.groups.view.hasPermission({ groupId, member: actor, permissionType: permissionsAdmin })) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "A room PermissionsAdmin member cannot use self-service leave; an authorized administrator must remove it through the permission-management path.");
        }
        let digest = "";
        try {
            const transaction = await client.messaging.leave({ signer, groupId });
            digest = transaction.digest;
            await baseClient.waitForTransaction({ digest, timeout: 60_000, pollInterval: 1_000 });
            if (await client.groups.view.isMember({ groupId, member: actor })) throw new Error("The acting agent still has room membership.");
            return { left: true, groupId, digest, verification: "finalized_membership_absent", source: "myso_fullnode" };
        } catch (error) {
            if (error instanceof McpRuntimeError) throw error;
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", digest ? `Transaction ${digest} finalized or submitted, but self-removal could not be verified. Reconcile the digest before retrying.` : "The acting agent could not leave this room.", { digest: digest || undefined, retryable: false, cause: error });
        }
    }

    async setRoomName(request: { groupRef: GroupRef; name: string }): Promise<unknown> {
        const { client, signer } = await this.createClient("send", true);
        const groupId = client.messaging.derive.resolveGroupRef(request.groupRef).groupId;
        const name = request.name.trim().normalize("NFC");
        if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) throw new McpRuntimeError("INVALID_ARGUMENT", "Room name must contain 1–128 printable characters.");
        const metadataAdmin = messagingPermissionTypes(client.messaging.packageConfig.originalPackageId).MetadataAdmin;
        if (!(await client.groups.view.hasPermission({ groupId, member: signer.toMySoAddress(), permissionType: metadataAdmin }))) throw new McpRuntimeError("CAPABILITY_DENIED", "The agent requires live MetadataAdmin permission on this room.");
        const transaction = await client.messaging.setGroupName({ signer, groupId, name });
        try {
            const metadata = await client.messaging.view.groupsMetadata({ groupIds: [groupId], refresh: true });
            if (metadata[groupId]?.name !== name) throw new Error("The fullnode did not return the updated room name.");
            return { updated: true, groupId, name, digest: transaction.digest, verification: "fullnode_metadata_refetched", source: "myso_fullnode" };
        } catch (error) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `Transaction ${transaction.digest} finalized, but room-name verification failed. Reconcile the transaction digest before retrying.`, { digest: transaction.digest, retryable: false, cause: error });
        }
    }

    async archiveRoom(request: { groupRef: GroupRef; ownerConfirmation: { owner: string; agentObjectId: string; groupId: string; expiresAtMs: number; nonce: string; signature: string } }): Promise<unknown> {
        const { client, signer, permissionedGroupsPackageId, baseClient } = await this.createClient("send", true);
        const groupId = client.messaging.derive.resolveGroupRef(request.groupRef).groupId;
        const context = parseContext(await this.getContext());
        const confirmation = request.ownerConfirmation;
        const expiresAtMs = confirmation.expiresAtMs;
        if (address(confirmation.owner, "confirmation owner") !== context.owner
            || address(confirmation.agentObjectId, "confirmation agent") !== context.agentObjectId
            || address(confirmation.groupId, "confirmation group") !== address(groupId, "room group ID")
            || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now() || expiresAtMs > Date.now() + 5 * 60_000
            || !/^[0-9a-f-]{36}$/i.test(confirmation.nonce)
            || typeof confirmation.signature !== "string" || confirmation.signature.length < 40 || confirmation.signature.length > 4096) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "A fresh owner-wallet signature bound to this room and agent is required.");
        }
        const canonical = `MySo Agents room archive\nOwner: ${context.owner}\nAgent: ${context.agentObjectId}\nGroup: ${address(groupId, "room group ID")}\nExpires: ${expiresAtMs}\nNonce: ${confirmation.nonce}`;
        try {
            const verifiedOwner = await verifyPersonalMessageSignature(new TextEncoder().encode(canonical), confirmation.signature);
            if (address(verifiedOwner.toMySoAddress(), "signed owner address") !== context.owner) throw new Error("Owner address mismatch");
        } catch {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "The owner-wallet confirmation signature is invalid.");
        }
        const actor = address(signer.toMySoAddress(), "agent signer");
        const permissionsAdmin = `${permissionedGroupsPackageId}::permissioned_group::PermissionsAdmin`;
        if (!(await client.groups.view.hasPermission({ groupId, member: actor, permissionType: permissionsAdmin }))) throw new McpRuntimeError("CAPABILITY_DENIED", "The agent requires live PermissionsAdmin authority on this exact room.");
        let digest = "";
        try {
            const transaction = await client.messaging.archiveGroup({ signer, groupId });
            digest = transaction.digest;
            await baseClient.waitForTransaction({ digest, timeout: 60_000, pollInterval: 1_000 });
            return { archived: true, groupId, digest, verification: "finalized_archive_transaction", source: "myso_fullnode" };
        } catch (error) {
            if (error instanceof McpRuntimeError) throw error;
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", digest ? `Archive transaction ${digest} finalized or submitted, but finalization could not be verified. Reconcile the digest before retrying.` : "The room could not be permanently archived.", { digest: digest || undefined, retryable: false, cause: error });
        }
    }

    async listRoomReactions(request: { groupRef: GroupRef; order: number }): Promise<unknown> {
        const { client, signer } = await this.createClient("read");
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingReader");
        const result = await client.messaging.listReactions({ signer, ...request });
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingReader");
        return result;
    }

    async changeRoomReaction(request: { groupRef: GroupRef; order: number; emoji: string; add: boolean }): Promise<unknown> {
        const { client, signer } = await this.createClient("send");
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingSender");
        const { add, ...reaction } = request;
        if (add) await client.messaging.addReaction({ signer, ...reaction });
        else await client.messaging.removeReaction({ signer, ...reaction });
        const result = await client.messaging.listReactions({ signer, groupRef: request.groupRef, order: request.order });
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingSender");
        return result;
    }

    async getRoomReceipts(request: { groupRef: GroupRef }): Promise<unknown> {
        const { client, signer } = await this.createClient("read");
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingReader");
        const result = await client.messaging.getGroupReceipts({ signer, ...request });
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingReader");
        return result;
    }

    async updateRoomReceipts(request: { groupRef: GroupRef; deliveredUpto?: number; readUpto?: number }): Promise<unknown> {
        const { client, signer } = await this.createClient("read");
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingReader");
        await client.messaging.postGroupReceipts({ signer, ...request });
        await this.assertRoomPermission(client, signer, request.groupRef, "MessagingReader");
        return { updated: true, metadataSource: "relayer_unverified" };
    }
}
