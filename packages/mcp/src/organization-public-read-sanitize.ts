import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The organization reader returned malformed, uncorrelated, or unauthorized data.");
type Row = Record<string, unknown>;
function object(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function sameAddress(left: unknown, right: unknown): boolean { return address(left) === address(right); }
function integer(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw fail();
    return value;
}
function int64(value: unknown, allowNegative = false): bigint {
    if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw fail(); value = String(value); }
    if (typeof value !== "string" || !(allowNegative ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)) throw fail();
    const parsed = BigInt(value);
    if (parsed > (1n << 63n) - 1n || parsed < (allowNegative ? -(1n << 63n) : 0n)) throw fail();
    return parsed;
}
function text(value: unknown, max = 512, allowEmpty = false): string {
    if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0)) throw fail();
    return value;
}
function nullableText(value: unknown, max: number): void { if (value !== null) text(value, max, true); }
function nullableAddress(value: unknown): void { if (value !== null) address(value); }
function timestamp(value: unknown): void { if (!Number.isFinite(Date.parse(text(value, 64)))) throw fail(); }
function supportedWindow(input: unknown): string {
    const map: Record<string, string> = { "7d": "days7", "30d": "days30", "180d": "days180", "365d": "days365", all: "all" };
    const selected = input === undefined ? "all" : input;
    if (typeof selected !== "string" || !map[selected]) throw fail();
    return map[selected];
}

const orgFields = ["organization_id", "account_id", "principal_owner", "profile_id", "name", "description", "org_type", "root_agent_id", "active", "created_at_ms", "deactivated_at_ms", "event_id", "transaction_id", "time", "org_memory_group_id"] as const;
function organization(value: unknown, expectedId?: unknown, expectedOwner?: unknown, expectedCategory?: number): Row {
    const row = object(value, orgFields);
    const organizationId = address(row.organization_id); address(row.account_id); address(row.principal_owner); address(row.profile_id);
    if (expectedId !== undefined && organizationId !== address(expectedId)) throw fail();
    if (expectedOwner !== undefined && !sameAddress(row.principal_owner, expectedOwner)) throw fail();
    for (const key of ["root_agent_id", "org_memory_group_id"] as const) nullableAddress(row[key]);
    nullableText(row.name, 128); nullableText(row.description, 4096);
    const category = integer(row.org_type, 0, categories.length - 1);
    if (expectedCategory !== undefined && category !== expectedCategory) throw fail();
    if (typeof row.active !== "boolean") throw fail();
    int64(row.created_at_ms); if (row.deactivated_at_ms !== null) int64(row.deactivated_at_ms);
    text(row.event_id, 256); text(row.transaction_id, 128); timestamp(row.time);
    return row;
}

const categories = [
    [0, "company", "Company"], [1, "startup", "Startup"], [2, "investment_fund", "Investment Fund"],
    [3, "nonprofit", "Nonprofit"], [4, "research", "Research"], [5, "government", "Government"],
    [6, "media", "Media"], [7, "stewardship", "Stewardship"], [8, "brand", "Brand"],
    [9, "community", "Community"], [10, "sports", "Sports"], [11, "education", "Education"],
    [12, "healthcare", "Healthcare"], [13, "other", "Other"],
] as const;

function categoryValue(slug: unknown): number {
    if (typeof slug !== "string") throw fail();
    const category = categories.find((item) => item[1] === slug);
    if (!category) throw fail();
    return category[0];
}
function invitation(value: unknown, invitee: string): void {
    const row = object(value, ["organization_id", "invitee_address", "role_name", "permissions_mask", "status", "invited_by", "created_at_ms", "expires_at_ms", "responded_at_ms", "responded_by", "granted_mask", "event_id", "transaction_id", "time"]);
    address(row.organization_id);
    if (!sameAddress(row.invitee_address, invitee) || row.status !== "pending") throw fail();
    if (row.role_name !== null) text(row.role_name, 128);
    if (int64(row.permissions_mask) < 0n) throw fail();
    address(row.invited_by); int64(row.created_at_ms);
    for (const key of ["expires_at_ms", "responded_at_ms", "granted_mask"] as const) if (row[key] !== null && int64(row[key]) < 0n) throw fail();
    nullableAddress(row.responded_by); text(row.event_id, 256); text(row.transaction_id, 128); timestamp(row.time);
}
function room(value: unknown, organizationId: string): void {
    const row = object(value, ["groupId", "roomKind", "taskId", "creatorActor", "creatorPrincipal", "organizationId", "groupName", "groupUuid", "createdAtMs", "transactionId"]);
    if (!sameAddress(row.organizationId, organizationId)) throw fail();
    address(row.groupId); integer(row.roomKind, 0, 32767);
    nullableAddress(row.taskId); address(row.creatorActor); address(row.creatorPrincipal);
    nullableText(row.groupName, 256); nullableText(row.groupUuid, 128); int64(row.createdAtMs); text(row.transactionId, 128);
}

export function sanitizeOrganizationPublicRead(name: string, value: unknown, args: Record<string, unknown>, context: { owner?: string; organizationId?: string | null; derivedAddress?: string }): unknown {
    if (name === "organization_get") return organization(value, args.id);
    if (name === "organization_list_owned") {
        const row = object(value, ["organizations", "total_count"]);
        if (!Array.isArray(row.organizations) || row.organizations.length > (typeof args.limit === "number" ? args.limit : 20)) throw fail();
        const total = int64(row.total_count);
        if (BigInt(row.organizations.length) > total || !context.owner) throw fail();
        const expectedCategory = typeof args.org_type === "number" ? args.org_type : undefined;
        const seen = new Set<string>();
        let previous: { createdAt: bigint; organizationId: string } | undefined;
        for (const item of row.organizations) {
            const org = organization(item, undefined, context.owner, expectedCategory);
            if (args.active_only !== false && org.active !== true) throw fail();
            const createdAt = int64(org.created_at_ms);
            const organizationId = address(org.organization_id);
            if (seen.has(organizationId) || previous && (previous.createdAt < createdAt
                || previous.createdAt === createdAt && previous.organizationId >= organizationId)) throw fail();
            seen.add(organizationId);
            previous = { createdAt, organizationId };
        }
        return row;
    }
    if (name === "organization_list_categories") {
        if (!Array.isArray(value) || value.length !== categories.length) throw fail();
        value.forEach((item, index) => {
            const row = object(item, ["value", "slug", "display_name"]); const expected = categories[index]!;
            if (row.value !== expected[0] || row.slug !== expected[1] || row.display_name !== expected[2]) throw fail();
        });
        return value;
    }
    if (name === "organization_get_statistics") {
        const fields = ["organization_id", "window", "total_revenue_myso", "total_outbound_spend_myso", "net_cash_flow_myso", "total_actions_executed", "total_agents", "active_agents", "total_counterparties", "total_posts", "total_engagement", "total_spot_participation", "total_transactions", "spot_accuracy", "spot_bets_resolved", "insufficient_sample", "originality_score_average", "originality_posts_analyzed", "estimated_assets_under_management_myso", "attribution_coverage", "ai_credit_spent_mist", "ai_credit_usage_events", "memory_entries", "memory_bytes", "org_shared_memory_entries", "organization_age_ms", "stats_rollup_at"];
        const row = object(value, fields);
        if (!context.organizationId || !sameAddress(row.organization_id, args.id)
            || !sameAddress(args.id, context.organizationId) || row.window !== supportedWindow(args.window)) throw fail();
        int64(row.total_revenue_myso, true); int64(row.total_outbound_spend_myso, true); int64(row.net_cash_flow_myso, true);
        for (const key of ["total_actions_executed", "total_agents", "active_agents", "total_counterparties", "total_posts", "total_engagement", "total_spot_participation", "total_transactions", "spot_bets_resolved", "originality_posts_analyzed", "ai_credit_usage_events", "memory_entries", "memory_bytes", "org_shared_memory_entries", "organization_age_ms"]) int64(row[key]);
        if (int64(row.active_agents) > int64(row.total_agents) || typeof row.insufficient_sample !== "boolean" || row.insufficient_sample !== (int64(row.spot_bets_resolved) < 5n)) throw fail();
        for (const key of ["total_revenue_myso", "total_outbound_spend_myso", "estimated_assets_under_management_myso", "ai_credit_spent_mist"]) int64(row[key], true);
        for (const key of ["spot_accuracy", "originality_score_average", "attribution_coverage"]) {
            const value = row[key]; if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) throw fail();
        }
        if (row.insufficient_sample && row.spot_accuracy !== null) throw fail();
        if (row.stats_rollup_at !== null) timestamp(row.stats_rollup_at);
        return row;
    }
    if (name === "organization_list_leaderboard") {
        const row = object(value, ["entries", "total"]); const expectedCategory = categoryValue(args.category);
        if (!Array.isArray(row.entries) || row.entries.length > (typeof args.limit === "number" ? args.limit : 20) || int64(row.total) < BigInt(row.entries.length)) throw fail();
        const offset = BigInt(typeof args.offset === "number" ? integer(args.offset, 0, 100_000) : 0);
        let previous: { sortValue: bigint; createdAt: bigint; organizationId: string } | undefined;
        for (const [index, item] of row.entries.entries()) {
            const entry = object(item, ["organization", "sort_value", "rank"]);
            const org = organization(entry.organization, undefined, undefined, expectedCategory);
            const rank = int64(entry.rank);
            if (rank !== offset + BigInt(index) + 1n || org.active !== true) throw fail();
            const sortValue = int64(entry.sort_value, true);
            const createdAt = int64(org.created_at_ms);
            const organizationId = address(org.organization_id);
            if (previous && (previous.sortValue < sortValue
                || previous.sortValue === sortValue && previous.createdAt > createdAt
                || previous.sortValue === sortValue && previous.createdAt === createdAt && previous.organizationId >= organizationId)) throw fail();
            previous = { sortValue, createdAt, organizationId };
        }
        return row;
    }
    if (name === "organization_list_my_invitations") {
        const row = object(value, ["invitations", "evidence"]);
        if (row.evidence !== "bounded_pending_invitee_indexer_preview" || !Array.isArray(row.invitations) || row.invitations.length > (typeof args.limit === "number" ? args.limit : 20) || !context.derivedAddress) throw fail();
        for (const item of row.invitations) invitation(item, context.derivedAddress);
        return row;
    }
    if (name === "organization_list_rooms") {
        const org = context.organizationId;
        if (!org || !Array.isArray(value) || value.length > (typeof args.limit === "number" ? args.limit : 20)) throw fail();
        const seen = new Set<string>();
        let previous: Row | undefined;
        for (const item of value) {
            room(item, org);
            const current = item as Row;
            const groupId = address(current.groupId);
            if (seen.has(groupId)) throw fail();
            seen.add(groupId);
            if (previous) {
                const previousCreated = int64(previous.createdAtMs);
                const currentCreated = int64(current.createdAtMs);
                if (previousCreated < currentCreated || previousCreated === currentCreated && String(previous.groupId) > String(current.groupId)) throw fail();
            }
            previous = current;
        }
        return value;
    }
    throw fail();
}
