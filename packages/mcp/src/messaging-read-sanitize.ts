import { McpRuntimeError } from "./errors.js";

const TOOLS = new Set([
    "messaging_get_room_details",
    "messaging_get_group_creation_receipt",
    "messaging_get_membership_change_receipt",
    "messaging_list_room_members",
    "messaging_list_room_digests",
    "messaging_get_message_receipt",
    "messaging_list_my_wallet_history",
    "messaging_list_my_paid_message_history",
    "messaging_get_my_revenue_summary",
    "messaging_get_task_room_binding_receipt",
    "room_list",
]);
const OWNER_BOUND_TOOLS = new Set([
    "messaging_list_my_wallet_history",
    "messaging_list_my_paid_message_history",
    "messaging_get_my_revenue_summary",
    "room_list",
]);
const invalid = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The messaging reader returned malformed or inconsistent metadata.");

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw invalid();
    return row;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw invalid();
    return value;
}
function sameAddress(left: unknown, right: unknown): boolean {
    const normalize = (value: unknown) => address(value).toLowerCase().replace(/^0x/, "").padStart(64, "0");
    return normalize(left) === normalize(right);
}
function safeInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
    return value;
}
function boundedString(value: unknown, max: number): string {
    if (typeof value !== "string" || value.length > max) throw invalid();
    return value;
}
function digest(value: unknown): string {
    if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) throw invalid();
    return value;
}
function decimal(value: unknown): string {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === "string" && value.length <= 20 && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n) return value;
    throw invalid();
}
function signedI64Decimal(value: unknown): string {
    const text = decimal(value);
    if (BigInt(text) > 9_223_372_036_854_775_807n) throw invalid();
    return text;
}
function i64Decimal(value: unknown): string {
    if (typeof value !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw invalid();
    const integer = BigInt(value);
    if (integer < -9_223_372_036_854_775_808n || integer > 9_223_372_036_854_775_807n) throw invalid();
    return value;
}
function contentDigest(value: unknown): void {
    if (typeof value !== "string" || !/^(?:0x)?[0-9a-f]{64}$/i.test(value)) throw invalid();
}

function digestItem(input: unknown, expectedGroup?: unknown): void {
    const row = object(input, ["groupId", "seq", "sender", "recipient", "contentDigest", "contentUri", "createdAtMs", "transactionId"]);
    address(row.groupId); address(row.sender); address(row.recipient);
    if (expectedGroup !== undefined && !sameAddress(row.groupId, expectedGroup)) throw invalid();
    signedI64Decimal(row.seq); safeInteger(row.createdAtMs); contentDigest(row.contentDigest);
    boundedString(row.contentUri, 8192); digest(row.transactionId);
}
function roomInfo(input: unknown, expectedGroup?: unknown): void {
    const room = object(input, ["groupId", "roomKind", "taskId", "creatorActor", "creatorPrincipal", "organizationId", "groupName", "groupUuid", "createdAtMs", "transactionId"]);
    address(room.groupId); safeInteger(room.roomKind, -32768, 32767); address(room.creatorActor); address(room.creatorPrincipal); safeInteger(room.createdAtMs); digest(room.transactionId);
    if (expectedGroup !== undefined && !sameAddress(room.groupId, expectedGroup)) throw invalid();
    if (!(room.taskId === null || typeof room.taskId === "string" && room.taskId.length <= 128)
        || !(room.organizationId === null || typeof room.organizationId === "string")
        || !(room.groupName === null || typeof room.groupName === "string" && room.groupName.length <= 1024)
        || !(room.groupUuid === null || typeof room.groupUuid === "string" && room.groupUuid.length <= 128)) throw invalid();
    if (room.organizationId !== null) address(room.organizationId);
}
function eventId(value: unknown): string {
    if (typeof value === "string") return address(value);
    if (value && typeof value === "object" && !Array.isArray(value)) return address((value as Record<string, unknown>).id);
    throw invalid();
}

function boundedArray(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) throw invalid();
    return value;
}

export function isMessagingReadName(name: string): boolean {
    return TOOLS.has(name);
}

/** Validates the typed, non-plaintext messaging read responses at either MCP boundary. */
export function sanitizeMessagingRead(name: string, value: unknown, args: Record<string, unknown>, expectedOwner?: string): unknown {
    if (!TOOLS.has(name)) throw new McpRuntimeError("UNKNOWN_TOOL", "No messaging read contract is registered for this tool.");
    if (OWNER_BOUND_TOOLS.has(name) && !expectedOwner) throw invalid();
    if (name === "messaging_get_group_creation_receipt") {
        const row=object(value,["digest","registryAction","groupId","groupName","groupUuid","status","checkpoint","events","evidenceSource"]);
        digest(row.digest);
        if(row.digest!==args.id||row.registryAction!=="messaging.create_group.v1"||!["finalized","checkpoint_pending","failed","unknown"].includes(String(row.status))||row.evidenceSource!=="configured_fullnode_and_scoped_action_record")throw invalid();
        if(row.groupId!==null)address(row.groupId);
        if(typeof row.groupName!=="string"||row.groupName.length<1||row.groupName.length>1024||typeof row.groupUuid!=="string"||row.groupUuid.length<1||row.groupUuid.length>128)throw invalid();
        if(row.checkpoint!==null&&!(typeof row.checkpoint==="string"&&/^(0|[1-9][0-9]*)$/.test(row.checkpoint)))throw invalid();
        const events=boundedArray(row.events,1);
        if(row.status==="finalized"&&(events.length!==1||row.groupId===null||row.checkpoint===null)||row.status==="failed"&&events.length!==0)throw invalid();
        for(const raw of events){
            const event=object(raw,["type","data"]);
            if(typeof event.type!=="string"||!event.type.endsWith("::messaging::AgentGroupCreated"))throw invalid();
            const data=object(event.data,["group_id","creator_actor","creator_principal","creator_sub_agent_id","creator_identity_class","organization_id","group_name","group_uuid","created_at"]);
            if(!sameAddress(data.group_id,row.groupId)||typeof data.creator_sub_agent_id!=="string")throw invalid();
            address(data.creator_actor);address(data.creator_principal);
            if(typeof data.creator_identity_class!=="number"||!Number.isInteger(data.creator_identity_class)||data.creator_identity_class<0||data.creator_identity_class>2||data.group_name!==row.groupName||data.group_uuid!==row.groupUuid)throw invalid();
            if(data.organization_id!==null)address(data.organization_id);
            safeInteger(Number(data.created_at));
        }
        return row;
    }
    if(name==="messaging_get_membership_change_receipt"){
        const row=object(value,["digest","status","kind","groupId","actor","members","keyRotation","events","checkpoint","evidenceSource"]);
        digest(row.digest);
        if(row.digest!==args.id||!["finalized","checkpoint_pending","failed","unknown"].includes(String(row.status))||!(["invite","leave","remove_and_rotate",null] as unknown[]).includes(row.kind)||row.evidenceSource!=="configured_fullnode_transaction_events")throw invalid();
        address(row.actor);
        if(row.groupId!==null)address(row.groupId);
        const members=boundedArray(row.members,50).map(address);
        if(new Set(members.map(member=>member.toLowerCase())).size!==members.length)throw invalid();
        if(row.checkpoint!==null)decimal(row.checkpoint);
        let keyRotation:{encryptionHistoryId:string;newKeyVersion:string}|null=null;
        if(row.keyRotation!==null){
            const item=object(row.keyRotation,["encryptionHistoryId","newKeyVersion"]);
            keyRotation={encryptionHistoryId:address(item.encryptionHistoryId),newKeyVersion:decimal(item.newKeyVersion)};
        }
        const events=boundedArray(row.events,256);
        const removed:string[]=[];
        const granted=new Map<string,Set<string>>();
        for(const raw of events){
            const event=object(raw,["type","groupId","member","permissions"]);
            if(!["MemberRemoved","PermissionsGranted"].includes(String(event.type))||!sameAddress(event.groupId,row.groupId))throw invalid();
            const member=address(event.member);const permissions=boundedArray(event.permissions,32).map(value=>boundedString(value,512));
            if(event.type==="MemberRemoved"){
                if(permissions.length!==0)throw invalid();
                removed.push(member);
            }else{
                const key=member.toLowerCase();const set=granted.get(key)??new Set<string>();for(const permission of permissions)set.add(permission);granted.set(key,set);
            }
        }
        if(row.kind==="remove_and_rotate"){
            if(!keyRotation||!members.length||removed.length!==members.length||removed.some((member,index)=>!sameAddress(member,members[index]!))||events.some(event=>(event as Record<string,unknown>).type!=="MemberRemoved"))throw invalid();
        }else if(row.kind==="leave"){
            if(keyRotation||members.length!==1||removed.length!==1||!sameAddress(members[0],row.actor)||!sameAddress(removed[0],row.actor))throw invalid();
        }else if(row.kind==="invite"){
            if(keyRotation||removed.length||!members.length||granted.size!==members.length||members.some(member=>{const set=granted.get(member.toLowerCase());return !set||![...set].some(type=>type.endsWith("::MessagingReader"))||![...set].some(type=>type.endsWith("::MessagingSender"));}))throw invalid();
        }else if(row.status==="finalized"||events.length||members.length||keyRotation)throw invalid();
        if(row.status==="finalized"&&(!row.groupId||!row.kind||!events.length))throw invalid();
        if(row.status==="failed"&&(row.kind||events.length||members.length||keyRotation))throw invalid();
        return row;
    }
    if (name === "messaging_get_room_details") {
        const row = object(value, ["room", "membershipEvidence", "metadataSource"]);
        if (row.membershipEvidence !== "configured_fullnode_current_messaging_reader" || row.metadataSource !== "social_indexer") throw invalid();
        roomInfo(row.room, args.id);
        return row;
    }
    if (name === "room_list") {
        const rooms = boundedArray(value, typeof args.limit === "number" ? args.limit : 20);
        const seen = new Set<string>();
        let previous: Record<string, unknown> | undefined;
        for (const raw of rooms) {
            roomInfo(raw);
            const room = raw as Record<string, unknown>;
            if (!sameAddress(room.creatorPrincipal, expectedOwner)) throw invalid();
            const normalizedGroup = address(room.groupId).toLowerCase().replace(/^0x/, "").padStart(64, "0");
            if (seen.has(normalizedGroup)) throw invalid();
            seen.add(normalizedGroup);
            if (previous) {
                const previousCreated = safeInteger(previous.createdAtMs);
                const currentCreated = safeInteger(room.createdAtMs);
                const previousGroup = String(previous.groupId);
                const currentGroup = String(room.groupId);
                if (previousCreated < currentCreated || previousCreated === currentCreated && previousGroup > currentGroup) throw invalid();
            }
            previous = room;
        }
        return rooms;
    }
    if (name === "messaging_list_room_members") {
        const row = object(value, ["groupId", "members", "limit", "hasNextPage", "nextCursor", "membershipEvidence", "source"]);
        const limit = safeInteger(row.limit, 1);
        const members = boundedArray(row.members, limit);
        if (!sameAddress(row.groupId, args.id) || typeof row.hasNextPage !== "boolean" || row.membershipEvidence !== "configured_fullnode_current_messaging_reader" || row.source !== "configured_fullnode_permission_table" || limit > 100 || typeof args.limit === "number" && limit > args.limit) throw invalid();
        if (!(row.nextCursor === null || typeof row.nextCursor === "string")) throw invalid();
        if (row.hasNextPage !== (row.nextCursor !== null) || row.hasNextPage && (!members.length || sameAddress(row.nextCursor, args.cursor ?? "0x0"))) throw invalid();
        if (row.nextCursor !== null) address(row.nextCursor);
        const seen = new Set<string>();
        for (const raw of members) {
            const member = object(raw, ["address", "permissions"]);
            const key = address(member.address).toLowerCase().replace(/^0x/, "").padStart(64, "0");
            if (seen.has(key)) throw invalid();
            seen.add(key);
            const permissions = boundedArray(member.permissions, 64).map((permission) => boundedString(permission, 512));
            if (permissions.some((permission) => permission.length === 0) || new Set(permissions).size !== permissions.length || permissions.some((permission, index) => index > 0 && permissions[index - 1] > permission)) throw invalid();
        }
        return row;
    }
    if (name === "messaging_list_room_digests") {
        const row = object(value, ["groupId", "items", "limit", "offset", "membershipEvidence", "digestSource"]);
        const limit = safeInteger(row.limit, 1);
        const offset = safeInteger(row.offset);
        const items = boundedArray(row.items, limit);
        if (!sameAddress(row.groupId, args.id) || typeof row.membershipEvidence !== "string" || row.membershipEvidence !== "configured_fullnode_current_messaging_reader" || row.digestSource !== "social_indexer" || limit > 100 || (args.offset !== undefined && offset !== args.offset)) throw invalid();
        if (typeof args.limit === "number" && limit > args.limit) throw invalid();
        let previousSequence: bigint | undefined;
        const seenSequences = new Set<string>();
        for (const item of items) {
            digestItem(item, row.groupId);
            const sequence = BigInt((item as Record<string, unknown>).seq as string);
            if (seenSequences.has(sequence.toString()) || previousSequence !== undefined && sequence <= previousSequence) throw invalid();
            seenSequences.add(sequence.toString());
            previousSequence = sequence;
        }
        return row;
    }
    if (name === "messaging_get_message_receipt") {
        const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
        if (!row || !sameAddress(row.groupId, args.id) || String(row.seq) !== args.seq || typeof row.status !== "string" || row.membershipEvidence !== "configured_fullnode_current_messaging_reader") throw invalid();
        signedI64Decimal(row.seq); digest(row.digest);
        if (row.status === "checkpoint_pending") {
            object(row, ["groupId", "seq", "digest", "status", "events", "membershipEvidence"]);
            if (!Array.isArray(row.events) || row.events.length !== 0) throw invalid();
            return row;
        }
        object(row, ["groupId", "seq", "digest", "status", "checkpoint", "event", "membershipEvidence", "evidenceSource"]);
        if (row.status !== "finalized" || row.evidenceSource !== "configured_fullnode_and_group_scoped_indexer_anchor") throw invalid();
            decimal(row.checkpoint);
        const event = object(row.event, ["group_id", "seq", "sender", "recipient", "content_digest", "content_uri", "created_at_ms"]);
        if (!sameAddress(event.group_id, row.groupId) || signedI64Decimal(event.seq) !== signedI64Decimal(row.seq)) throw invalid();
        address(event.sender); address(event.recipient); contentDigest(typeof event.content_digest === "string" ? event.content_digest : `0x${Array.isArray(event.content_digest) ? event.content_digest.map((n) => Number(n).toString(16).padStart(2, "0")).join("") : ""}`);
        boundedString(event.content_uri, 8192); safeInteger(Number(event.created_at_ms));
        return row;
    }
    if (name === "messaging_list_my_wallet_history") {
        const rows = boundedArray(value, typeof args.limit === "number" ? args.limit : 20);
        for (const raw of rows) {
            digestItem(raw);
            const row = raw as Record<string, unknown>;
            if (!sameAddress(row.sender, expectedOwner) && !sameAddress(row.recipient, expectedOwner)) throw invalid();
        }
        return rows;
    }
    if (name === "messaging_list_my_paid_message_history") {
        const rows = boundedArray(value, typeof args.limit === "number" ? args.limit : 20);
        const seenPayments = new Set<string>();
        for (const raw of rows) {
            const row = object(raw, ["groupId", "seq", "payer", "recipient", "amount", "status", "platformFee", "treasuryFee", "netAmount", "replyCharCount", "createdAtMs", "claimedAtMs", "refundedAtMs", "transactionId"]);
            address(row.groupId); address(row.payer); address(row.recipient); digest(row.transactionId);
            if (!sameAddress(row.payer, expectedOwner) && !sameAddress(row.recipient, expectedOwner)) throw invalid();
            const seq = signedI64Decimal(row.seq);
            const paymentKey = `${address(row.groupId).toLowerCase().replace(/^0x/, "").padStart(64, "0")}:${seq}`;
            if (seenPayments.has(paymentKey)) throw invalid();
            seenPayments.add(paymentKey);
            for (const key of ["amount", "platformFee", "treasuryFee", "netAmount"] as const) if (row[key] !== null && BigInt(decimal(row[key])) > 9_223_372_036_854_775_807n) throw invalid();
            safeInteger(row.createdAtMs);
            for (const key of ["replyCharCount", "claimedAtMs", "refundedAtMs"] as const) if (row[key] !== null) safeInteger(row[key]);
            boundedString(row.status, 64);
        }
        return rows;
    }
    if (name === "messaging_get_task_room_binding_receipt") {
        const row = object(value, ["digest", "registryAction", "groupId", "taskId", "status", "events", "evidenceSource", "verification"]);
        digest(row.digest);
        if (row.digest !== args.id || row.registryAction !== "messaging.bind_room_to_task.v1" || !["finalized", "checkpoint_pending", "failed", "unknown"].includes(String(row.status)) || row.evidenceSource !== "configured_fullnode_and_scoped_action_record" || !Array.isArray(row.events) || row.events.length > 1) throw invalid();
        address(row.groupId); address(row.taskId);
        if (row.status === "finalized" && row.events.length !== 1) throw invalid();
        if (row.verification !== (row.status === "finalized" ? "finalized_agent_room_task_bound_event" : "task_room_binding_not_finalized")) throw invalid();
        for (const raw of row.events) {
            const event = object(raw, ["type", "data"]);
            if (typeof event.type !== "string" || !event.type.endsWith("::messaging::AgentRoomTaskBound")) throw invalid();
            const data = object(event.data, ["group_id", "task_id", "binder_actor", "binder_principal", "organization_id", "bound_at_ms"]);
            if (!sameAddress(eventId(data.group_id), row.groupId) || !sameAddress(eventId(data.task_id), row.taskId)) throw invalid();
            address(data.binder_actor); address(data.binder_principal);
            if (data.organization_id !== null) eventId(data.organization_id);
            safeInteger(Number(data.bound_at_ms));
        }
        return row;
    }
    const row = object(value, ["address", "totalMessagingRevenue"]);
    if (!sameAddress(row.address, expectedOwner)) throw invalid();
    i64Decimal(row.totalMessagingRevenue);
    return row;
}
