import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The creator-vault reader returned malformed or uncorrelated data.");
type Row = Record<string, unknown>;
const addressPattern = /^(0x)?[0-9a-f]{1,64}$/i;
function object(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !addressPattern.test(value)) throw fail();
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function sameAddress(left: unknown, right: unknown): boolean { return address(left) === address(right); }
function identityHash(value: unknown): string {
    if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2}){1,32}$/i.test(value)) throw fail();
    return value.toLowerCase();
}
function requestArgs(args: Record<string, unknown>): Row {
    const request = args.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) throw fail();
    return request as Row;
}
function secureUrl(value: unknown): string {
    const raw = text(value, 4096);
    try {
        const url = new URL(raw);
        if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw fail();
    } catch { throw fail(); }
    return raw;
}
function transferStatus(value: unknown): string {
    if (typeof value !== "string" || !["queued", "pending", "processing", "completed", "failed", "finalized", "checkpoint_pending", "unknown"].includes(value)) throw fail();
    return value;
}
function transactionDigest(value: unknown): string {
    const raw = text(value, 64);
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(raw)) throw fail();
    return raw;
}
function eventBytes(value: unknown): number[] | null {
    if (Array.isArray(value)) return value.every((byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255) ? value as number[] : null;
    if (typeof value !== "string") return null;
    const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : "";
    if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
    return Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}
function int64(value: unknown, allowNegative = false): bigint {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw fail();
        value = String(value);
    }
    if (typeof value !== "string" || !(allowNegative ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)) throw fail();
    const parsed = BigInt(value);
    const min = allowNegative ? -(1n << 63n) : 0n;
    if (parsed < min || parsed > (1n << 63n) - 1n) throw fail();
    return parsed;
}
function text(value: unknown, max = 256): string { if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail(); return value; }
function publicPocAnalytics(value: unknown): unknown {
    const row = object(value, ["total_badges", "total_disputes", "total_revenue_redirections"]);
    for (const field of ["total_badges", "total_disputes", "total_revenue_redirections"]) int64(row[field]);
    return row;
}
function publicPocConfiguration(value: unknown): unknown {
    const fields = [
        "image_threshold", "video_threshold", "audio_threshold", "revenue_redirect_percentage", "dispute_cost",
        "min_vote_stake", "max_vote_stake", "voting_duration_ms", "max_reasoning_length", "max_evidence_urls",
        "max_votes_per_dispute", "dispute_governance_registry_id", "oracle_address", "claim_treasury_fee_bps",
        "max_referral_bps", "video_embedded_audio_redirect_bps", "dispute_quorum_base_stake",
        "dispute_second_round_fee_multiplier_bps", "dispute_second_round_quorum_multiplier_bps",
        "username_beneficiary_join_referral_bps", "max_disputes_per_post", "min_vault_deposit_amount",
        "media_asset_dispute_cost", "max_disputes_per_media_asset", "max_embedded_asset_redirect_bps",
        "updated_by", "updated_at", "transaction_id", "version", "time",
    ] as const;
    const row = object(value, fields);
    for (const field of fields) {
        if (["dispute_governance_registry_id", "oracle_address"].includes(field)) {
            if (row[field] !== null) address(row[field]);
        } else if (["updated_by", "transaction_id"].includes(field)) {
            text(row[field], 128);
        } else if (field === "time") {
            const timestamp = text(row[field], 64);
            if (!Number.isFinite(Date.parse(timestamp))) throw fail();
        } else if (["max_disputes_per_post", "max_disputes_per_media_asset"].includes(field)) {
            smallInt(row[field], 0);
        } else {
            int64(row[field]);
        }
    }
    return row;
}
function assertDescendingPage(value: unknown[], timestampField: string, identityField: string, addressIdentity: boolean): void {
    let previousTimestamp: bigint | undefined;
    let previousIdentity: string | undefined;
    const seen = new Set<string>();
    for (const raw of value) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
        const row = raw as Row;
        const timestamp = int64(row[timestampField]);
        const identity = addressIdentity ? address(row[identityField]) : text(row[identityField], 128).toLowerCase();
        if (seen.has(identity) || previousTimestamp !== undefined && (timestamp > previousTimestamp || timestamp === previousTimestamp && identity >= previousIdentity!)) throw fail();
        seen.add(identity);
        previousTimestamp = timestamp;
        previousIdentity = identity;
    }
}
function smallInt(value: unknown, min = -32768, max = 32767): void {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw fail();
}
function nullableAddress(value: unknown): void { if (value !== null) address(value); }
function isoTime(value: unknown): void { const raw = text(value, 64); if (!Number.isFinite(Date.parse(raw))) throw fail(); }
function publicPocRow(name: string, value: unknown, args: Record<string, unknown>): unknown {
    const id = args.id;
    const validate = (item: unknown): void => {
        if (name === "poc_list_badges" || name === "poc_get_badge") {
            const row = object(item, ["badge_id", "post_id", "media_type", "issued_by", "issued_at", "revoked", "beneficiary_address", "matched_anchor_id", "media_index"]);
            address(row.badge_id); address(row.post_id); smallInt(row.media_type, 1, 3); address(row.issued_by); int64(row.issued_at);
            if (typeof row.revoked !== "boolean") throw fail(); nullableAddress(row.beneficiary_address);
            if (row.matched_anchor_id !== null) address(row.matched_anchor_id);
            if (row.media_index !== null) smallInt(row.media_index, 0);
            if (name === "poc_get_badge" && !sameAddress(row.badge_id, id)) throw fail();
            return;
        }
        if (name === "poc_list_revenue_redirections") {
            const row = object(item, ["redirection_id", "accused_post_id", "original_post_id", "redirect_percentage", "similarity_score", "created_at", "removed"]);
            address(row.redirection_id); address(row.accused_post_id); address(row.original_post_id);
            int64(row.redirect_percentage); int64(row.similarity_score); int64(row.created_at);
            if (row.removed !== null && typeof row.removed !== "boolean") throw fail();
            return;
        }
        if (name === "poc_list_analysis_results") {
            const row = object(item, ["post_id", "similarity_detected", "highest_similarity_score", "media_type", "oracle_address", "original_creator", "analysis_timestamp", "reasoning", "evidence_urls"]);
            address(row.post_id); if (typeof row.similarity_detected !== "boolean") throw fail();
            int64(row.highest_similarity_score); smallInt(row.media_type, 1, 3); address(row.oracle_address); nullableAddress(row.original_creator);
            int64(row.analysis_timestamp); if (row.reasoning !== null) text(row.reasoning, 16384); if (row.evidence_urls !== null) jsonValue(row.evidence_urls);
            return;
        }
        if (name === "poc_list_disputes" || name === "poc_get_dispute") {
            const row = object(item, ["dispute_id", "post_id", "disputer", "dispute_type", "evidence", "status", "resolution", "stake_amount", "voting_start_ms", "voting_end_ms", "winning_side", "total_winning_stake", "total_losing_stake", "submitted_at", "resolved_at", "dispute_round", "effective_dispute_fee", "required_total_stake_quorum", "quorum_met"]);
            address(row.dispute_id); address(row.post_id); address(row.disputer); smallInt(row.dispute_type, 0); text(row.evidence, 16384);
            smallInt(row.status, 1, 3); if (row.resolution !== null) smallInt(row.resolution, 1, 3);
            int64(row.stake_amount); int64(row.voting_start_ms); int64(row.voting_end_ms);
            if (row.winning_side !== null) smallInt(row.winning_side, 1, 2);
            nullableInt64(row.total_winning_stake); nullableInt64(row.total_losing_stake);
            int64(row.submitted_at); nullableInt64(row.resolved_at); smallInt(row.dispute_round, 1, 2);
            int64(row.effective_dispute_fee); int64(row.required_total_stake_quorum);
            if (row.quorum_met !== null && typeof row.quorum_met !== "boolean") throw fail();
            if (name === "poc_get_dispute" && !sameAddress(row.dispute_id, id)) throw fail();
            return;
        }
        if (name === "poc_list_dispute_votes") {
            const row = object(item, ["dispute_id", "voter", "vote_choice", "stake_amount", "voted_at", "reward_claimed", "reward_amount"]);
            if (!sameAddress(row.dispute_id, id)) throw fail(); address(row.voter); smallInt(row.vote_choice, 1, 2);
            int64(row.stake_amount); int64(row.voted_at);
            if (row.reward_claimed !== null && typeof row.reward_claimed !== "boolean") throw fail(); nullableInt64(row.reward_amount);
            return;
        }
        if (["poc_list_username_beneficiaries", "poc_get_username_beneficiary", "poc_get_username_beneficiary_by_username"].includes(name)) {
            const row = object(item, ["beneficiary_id", "username", "status", "creator_identity_source", "creator_identity_hash", "vault_routing_key", "vault_id", "required_x_handle", "oracle_evidence_hash", "provisioned_at_ms", "provisioned_by", "claimed_profile_id", "claimed_by", "claimed_at_ms", "ended_at_ms", "ended_by", "end_reason_code", "join_referrer", "join_referral_paid", "join_referral_paid_at_ms", "transaction_id", "time"]);
            address(row.beneficiary_id); text(row.username, 32); smallInt(row.status); smallInt(row.creator_identity_source);
            if (name === "poc_list_username_beneficiaries" && typeof args.status === "number" && row.status !== args.status) throw fail();
            text(row.creator_identity_hash, 128); address(row.vault_routing_key); address(row.vault_id); text(row.required_x_handle, 256); text(row.oracle_evidence_hash, 256);
            int64(row.provisioned_at_ms); address(row.provisioned_by); nullableAddress(row.claimed_profile_id); nullableAddress(row.claimed_by);
            nullableInt64(row.claimed_at_ms); nullableInt64(row.ended_at_ms); nullableAddress(row.ended_by);
            if (row.end_reason_code !== null) smallInt(row.end_reason_code); if (row.join_referrer !== null) address(row.join_referrer);
            if (typeof row.join_referral_paid !== "boolean") throw fail(); nullableInt64(row.join_referral_paid_at_ms);
            text(row.transaction_id, 128); isoTime(row.time);
            if (name === "poc_get_username_beneficiary" && !sameAddress(row.beneficiary_id, id)) throw fail();
            if (name === "poc_get_username_beneficiary_by_username" && row.username !== args.username) throw fail();
            return;
        }
        throw fail();
    };
    if (name === "poc_get_badge" || name === "poc_get_dispute" || name === "poc_get_username_beneficiary" || name === "poc_get_username_beneficiary_by_username") {
        validate(value); return value;
    }
    if (!Array.isArray(value) || value.length > (typeof args.limit === "number" ? Math.min(100, args.limit) : 20)) throw fail();
    value.forEach(validate);
    const ordering: Record<string, readonly [string, string, boolean]> = {
        poc_list_badges: ["issued_at", "badge_id", true],
        poc_list_revenue_redirections: ["created_at", "redirection_id", true],
        poc_list_analysis_results: ["analysis_timestamp", "post_id", true],
        poc_list_disputes: ["submitted_at", "dispute_id", true],
        poc_list_dispute_votes: ["voted_at", "voter", true],
        poc_list_username_beneficiaries: ["provisioned_at_ms", "beneficiary_id", true],
    };
    const pageOrder = ordering[name];
    if (pageOrder) assertDescendingPage(value, ...pageOrder);
    return value;
}
function nullableInt64(value: unknown): void { if (value !== null) int64(value); }
function coinType(value: unknown): string {
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
    const nested = row?.fields && typeof row.fields === "object" && !Array.isArray(row.fields) ? row.fields as Row : undefined;
    const name = typeof value === "string" ? value : row?.name ?? nested?.name;
    if (typeof name !== "string" || name.length > 1024 || !/^((0x)?[0-9a-fA-F]{1,64})::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(?:<.*>)?$/.test(name)) throw fail();
    return name;
}
function digest(value: unknown): void { text(value, 128); }
function jsonValue(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): void {
    budget.nodes += 1; if (budget.nodes > 256 || depth > 8) throw fail();
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") budget.bytes += value.length;
    else if (typeof value === "number") { if (!Number.isFinite(value)) throw fail(); budget.bytes += String(value).length; }
    else if (Array.isArray(value)) { if (value.length > 128) throw fail(); for (const item of value) jsonValue(item, depth + 1, budget); }
    else if (typeof value === "object") { const entries = Object.entries(value as Row); if (entries.length > 128) throw fail(); for (const [key, item] of entries) { budget.bytes += key.length; jsonValue(item, depth + 1, budget); } }
    else throw fail();
    if (budget.bytes > 16_384) throw fail();
}

function vault(value: unknown, expectedVault?: unknown, expectedBeneficiary?: unknown): Row {
    const row = object(value, ["vault_id", "vault_routing_key", "updated_at_ms", "transaction_id"]);
    const vaultId = address(row.vault_id); const routingKey = address(row.vault_routing_key);
    if (expectedVault !== undefined && vaultId !== address(expectedVault)) throw fail();
    if (expectedBeneficiary !== undefined && routingKey !== address(expectedBeneficiary)) throw fail();
    int64(row.updated_at_ms); digest(row.transaction_id);
    return row;
}
function balance(value: unknown, expectedVault: string): string {
    const row = object(value, ["vault_id", "coin_type", "balance", "updated_at_ms"]);
    if (!sameAddress(row.vault_id, expectedVault)) throw fail();
    const type = coinType(row.coin_type); int64(row.balance); int64(row.updated_at_ms);
    return type;
}
function deposit(value: unknown, expectedVault: string): [bigint, bigint] {
    const row = object(value, ["id", "vault_id", "vault_routing_key", "amount", "coin_type", "source_post_id", "occurred_at_ms", "transaction_id"]);
    const id = int64(row.id), occurredAt = int64(row.occurred_at_ms);
    if (id < 1n || !sameAddress(row.vault_id, expectedVault)) throw fail();
    address(row.vault_routing_key); int64(row.amount); coinType(row.coin_type);
    if (row.source_post_id !== null) address(row.source_post_id);
    digest(row.transaction_id);
    return [occurredAt, id];
}
function claim(value: unknown, expectedVault: string): [bigint, bigint] {
    const row = object(value, ["id", "vault_id", "vault_routing_key", "coin_type", "referrer_address", "treasury_amount", "referrer_amount", "beneficiary_amount", "occurred_at_ms", "transaction_id", "claim_kind", "gross_amount"]);
    const id = int64(row.id), occurredAt = int64(row.occurred_at_ms);
    if (id < 1n || !sameAddress(row.vault_id, expectedVault)) throw fail();
    address(row.vault_routing_key); coinType(row.coin_type);
    if (row.referrer_address !== null) address(row.referrer_address);
    const treasury = int64(row.treasury_amount), referrer = int64(row.referrer_amount), beneficiary = int64(row.beneficiary_amount);
    if (int64(row.gross_amount) !== treasury + referrer + beneficiary) throw fail();
    digest(row.transaction_id);
    if (row.claim_kind !== null) text(row.claim_kind, 80);
    return [occurredAt, id];
}
function eventAmount(row: Row, key: string): bigint { return int64(row[key]); }
function claimEvent(value: unknown): Row {
    const row = object(value, ["vault_id", "beneficiary", "coin_type", "referrer", "treasury_amount", "referrer_amount", "beneficiary_amount", "join_referral_applied", "timestamp"]);
    address(row.vault_id); address(row.beneficiary); coinType(row.coin_type);
    if (row.referrer !== null && !(row.referrer && typeof row.referrer === "object" && !Array.isArray(row.referrer) && Array.isArray(((row.referrer as Row).fields as Row | undefined)?.vec) && ((((row.referrer as Row).fields as Row).vec as unknown[]).length === 0 || (((row.referrer as Row).fields as Row).vec as unknown[]).length === 1))) address(row.referrer);
    eventAmount(row, "treasury_amount"); eventAmount(row, "referrer_amount"); eventAmount(row, "beneficiary_amount"); int64(row.timestamp);
    if (typeof row.join_referral_applied !== "boolean") throw fail();
    return row;
}
function transferEvent(value: unknown, beneficiary: string, recipient: string): Row {
    const row = object(value, ["beneficiary_id", "identity_source", "identity_hash", "recipient", "accepted_at"]);
    if (!sameAddress(row.beneficiary_id, beneficiary) || !sameAddress(row.recipient, recipient)) throw fail();
    if (typeof row.identity_source !== "number" || !Number.isInteger(row.identity_source) || row.identity_source < 0 || row.identity_source > 255) throw fail();
    if (!Array.isArray(row.identity_hash) || row.identity_hash.length > 128 || row.identity_hash.some((byte) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)) throw fail();
    int64(row.accepted_at); return row;
}

function proposalEvent(value: unknown, identity: string, beneficiary: string, recipient: string): Row {
    const row = object(value, ["beneficiary_id", "identity_source", "identity_hash", "recipient", "evidence_hash", "proposed_by", "proposed_at"]);
    if (!sameAddress(row.beneficiary_id, beneficiary) || !sameAddress(row.recipient, recipient) || row.identity_source !== 1) throw fail();
    const identityBytes = eventBytes(row.identity_hash), evidenceBytes = eventBytes(row.evidence_hash);
    if (!identityBytes || `0x${identityBytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}` !== identity || !evidenceBytes || evidenceBytes.length !== 32) throw fail();
    address(row.proposed_by); int64(row.proposed_at);
    return row;
}

function normalizeMoveType(value: string): string {
    const match = /^(0x[0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (!match) throw fail();
    return `${address(match[1])}::${match[2]}::${match[3]}`;
}

function sanitizeBeneficiaryTransfer(name: string, value: unknown, args: Record<string, unknown>, owner?: string, network?: string, packageId?: string): unknown {
    const request = requestArgs(args);
    const identity = identityHash(request.identity_hash);
    const expectedBeneficiary = request.beneficiary_id === undefined ? undefined : address(request.beneficiary_id);
    const expectedRecipient = request.recipient_address === undefined ? undefined : address(request.recipient_address);
    if (name === "poc_start_beneficiary_transfer_verification") {
        const row = object(value, ["network", "identity_hash", "authorize_url"]);
        if (identityHash(row.identity_hash) !== identity || typeof row.network !== "string" || !["mainnet", "testnet", "devnet", "localnet"].includes(row.network) || (network && row.network !== network)) throw fail();
        return { network: row.network, identity_hash: identity, authorize_url: secureUrl(row.authorize_url) };
    }
    if (name === "poc_get_beneficiary_transfer_verification") {
        const row = object(value, ["network", "identity_hash", "claimable", "oauth_required", "oauth_complete", "required_x_handle", "authorize_url", "attested_x_handle", "beneficiary"]);
        if (identityHash(row.identity_hash) !== identity || typeof row.network !== "string" || !["mainnet", "testnet", "devnet", "localnet"].includes(row.network) || (network && row.network !== network)) throw fail();
        if (typeof row.claimable !== "boolean" || typeof row.oauth_required !== "boolean" || typeof row.oauth_complete !== "boolean" || (row.oauth_required && row.oauth_complete)) throw fail();
        for (const field of ["required_x_handle", "attested_x_handle"]) if (row[field] !== null) text(row[field], 256);
        if (row.oauth_complete && (row.attested_x_handle === null || row.authorize_url !== null)) throw fail();
        if (row.oauth_required && row.attested_x_handle !== null) throw fail();
        if (row.authorize_url !== null) secureUrl(row.authorize_url);
        if (row.beneficiary !== null) jsonValue(row.beneficiary);
        // The upstream beneficiary row includes unrelated database metadata; do not disclose it to MCP callers.
        return {
            network: row.network,
            identity_hash: identity,
            beneficiary_id: expectedBeneficiary ? `0x${expectedBeneficiary}` : null,
            claimable: row.claimable,
            oauth_required: row.oauth_required,
            oauth_complete: row.oauth_complete,
            required_x_handle: row.required_x_handle,
            authorize_url: row.authorize_url === null ? null : secureUrl(row.authorize_url),
            attested_x_handle: row.attested_x_handle,
        };
    }
    if (name === "poc_propose_beneficiary_transfer") {
        const row = object(value, ["network", "job_id", "status"]);
        if (typeof row.network !== "string" || !["mainnet", "testnet", "devnet", "localnet"].includes(row.network) || (network && row.network !== network) || row.status !== "queued" || typeof row.job_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.job_id) || !expectedBeneficiary || !expectedRecipient) throw fail();
        return { network: row.network, job_id: row.job_id.toLowerCase(), status: "queued", identity_hash: identity, beneficiary_id: `0x${expectedBeneficiary}`, recipient_address: `0x${expectedRecipient}` };
    }
    if (name === "poc_get_beneficiary_transfer_job") {
        const row = object(value, ["status", "tx_digest", "error"]);
        const status = transferStatus(row.status);
        if (!["queued", "pending", "processing", "completed", "failed"].includes(status) || (row.tx_digest !== null && typeof row.tx_digest !== "string") || (row.error !== null && typeof row.error !== "string")) throw fail();
        const txDigest = row.tx_digest === null ? null : transactionDigest(row.tx_digest);
        const error = row.error === null ? null : text(row.error, 1000);
        if ((status === "completed" && (!txDigest || error !== null)) || (status === "failed" && (!error || txDigest !== null)) || (["queued", "pending", "processing"].includes(status) && (txDigest !== null || error !== null))) throw fail();
        return { status, tx_digest: txDigest, error };
    }
    if (name === "poc_get_beneficiary_transfer_proposal_receipt") {
        if (!expectedBeneficiary || !expectedRecipient || typeof request.job_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.job_id)) throw fail();
        const row = value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
        if (!row || identityHash(row.identityHash) !== identity || !sameAddress(row.beneficiaryId, expectedBeneficiary) || !sameAddress(row.recipient, expectedRecipient)) throw fail();
        const status = transferStatus(row.status);
        if (status === "queued") {
            const queued = object(value, ["status", "jobId", "identityHash", "beneficiaryId", "recipient"]);
            if (typeof queued.jobId !== "string" || queued.jobId.toLowerCase() !== request.job_id.toLowerCase()) throw fail();
            return { status, jobId: queued.jobId.toLowerCase(), identityHash: identity, beneficiaryId: `0x${expectedBeneficiary}`, recipient: `0x${expectedRecipient}` };
        }
        if (status === "failed") {
            const failed = object(value, ["status", "identityHash", "beneficiaryId", "recipient", "error"]);
            return { status, identityHash: identity, beneficiaryId: `0x${expectedBeneficiary}`, recipient: `0x${expectedRecipient}`, error: text(failed.error, 1000) };
        }
        const receipt = object(value, ["digest", "status", "checkpoint", "identityHash", "beneficiaryId", "recipient", "proposal", "proposalEventType", "evidenceSource"]);
        if (!packageId || receipt.evidenceSource !== "configured_fullnode_and_scoped_oracle_job") throw fail();
        const digestValue = transactionDigest(receipt.digest);
        const checkpoint = receipt.checkpoint === null ? null : int64(receipt.checkpoint);
        const expectedType = `${packageId}::proof_of_creativity::UsernameBeneficiaryTransferProposedEvent`;
        if (receipt.proposal === null) {
            if (status === "finalized" || receipt.proposalEventType !== null) throw fail();
        } else {
            const event = proposalEvent(receipt.proposal, identity, expectedBeneficiary, expectedRecipient);
            if (typeof receipt.proposalEventType !== "string" || normalizeMoveType(receipt.proposalEventType) !== normalizeMoveType(expectedType)) throw fail();
            receipt.proposal = event;
        }
        if (status === "finalized" && checkpoint === null) throw fail();
        return { ...receipt, digest: digestValue, checkpoint: checkpoint?.toString() ?? null, status };
    }
    throw fail();
}

export function sanitizePocRead(name: string, value: unknown, args: Record<string, unknown>, owner?: string, network?: string, packageId?: string): unknown {
    if (name === "poc_get_analytics") return publicPocAnalytics(value);
    if (name === "poc_get_configuration") return publicPocConfiguration(value);
    if (["poc_list_badges", "poc_get_badge", "poc_list_revenue_redirections", "poc_list_analysis_results", "poc_list_disputes", "poc_get_dispute", "poc_list_dispute_votes", "poc_list_username_beneficiaries", "poc_get_username_beneficiary", "poc_get_username_beneficiary_by_username"].includes(name)) return publicPocRow(name, value, args);
    if (["poc_start_beneficiary_transfer_verification", "poc_get_beneficiary_transfer_verification", "poc_propose_beneficiary_transfer", "poc_get_beneficiary_transfer_job", "poc_get_beneficiary_transfer_proposal_receipt"].includes(name)) return sanitizeBeneficiaryTransfer(name, value, args, owner, network, packageId);
    if (name === "poc_get_beneficiary_vault") return vault(value, args.id);
    if (name === "poc_get_vault_for_beneficiary") return vault(value, undefined, args.address);
    if (name === "poc_list_vault_coin_balances" || name === "poc_list_vault_deposits" || name === "poc_list_vault_claims") {
        if (!Array.isArray(value) || value.length > (typeof args.limit === "number" ? args.limit : 100)) throw fail();
        const seenTypes = new Set<string>();
        let previousEvent: [bigint, bigint] | undefined;
        for (const row of value) {
            if (name === "poc_list_vault_coin_balances") {
                const type = balance(row, String(args.id));
                if (seenTypes.has(type)) throw fail();
                seenTypes.add(type);
            } else {
                const event = name === "poc_list_vault_deposits" ? deposit(row, String(args.id)) : claim(row, String(args.id));
                if (previousEvent && !(event[0] < previousEvent[0] || (event[0] === previousEvent[0] && event[1] < previousEvent[1]))) throw fail();
                previousEvent = event;
            }
        }
        return value;
    }
    if (name === "poc_get_claim_receipt") {
        const row = object(value, ["digest", "registryAction", "status", "checkpoint", "claim", "evidenceSource", "currentVaultBalance"]);
        if (row.digest !== args.id || row.registryAction !== "poc.claim_creator_vault.v1" || !["finalized", "checkpoint_pending", "failed", "unknown"].includes(String(row.status)) || row.evidenceSource !== "configured_fullnode_and_scoped_preparation" || row.currentVaultBalance !== "not_checked") throw fail();
        digest(row.digest); if (row.checkpoint !== null) int64(row.checkpoint);
        if (row.claim !== null) {
            const event = claimEvent(row.claim);
            if (owner && !sameAddress(event.beneficiary, owner)) throw fail();
            if (row.status === "finalized" && !owner) throw fail();
        } else if (row.status === "finalized") throw fail();
        return row;
    }
    if (name === "poc_get_beneficiary_transfer_receipt") {
        const row = object(value, ["digest", "registryAction", "status", "checkpoint", "beneficiaryId", "recipient", "acceptance", "evidenceSource"]);
        if (row.digest !== args.id || row.registryAction !== "poc.accept_beneficiary_transfer.v1" || !["finalized", "checkpoint_pending", "failed", "unknown"].includes(String(row.status)) || row.evidenceSource !== "configured_fullnode_and_scoped_preparation") throw fail();
        digest(row.digest); const beneficiary = address(row.beneficiaryId); const recipient = address(row.recipient);
        if (row.checkpoint !== null) int64(row.checkpoint);
        if (owner && !sameAddress(recipient, owner)) throw fail();
        if (row.acceptance !== null) transferEvent(row.acceptance, beneficiary, recipient);
        else if (row.status === "finalized") throw fail();
        if (row.status === "finalized" && !owner) throw fail();
        return row;
    }
    if (value !== null) jsonValue(value);
    return value;
}
