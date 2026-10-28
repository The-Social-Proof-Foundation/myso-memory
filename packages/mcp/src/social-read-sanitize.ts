import { McpRuntimeError } from "./errors.js";
import { SOCIAL_READ_CONTRACTS } from "./social-read-contract.js";

type Spec = { nullable?: boolean; kind: Kind };
type Kind = string | "blockEvent" | "quantity" | { enum: readonly string[] } | { object: Record<string, Spec> } | { array: Record<string, Spec> };
type Contract = { list?: boolean; scope?: string; value?: boolean; nullable?: boolean; keys?: readonly string[]; fields?: Record<string, Spec> };

const field = (kind: Kind, nullable = false): Spec => ({ kind, nullable });
const pageFields = {
    total: field("quantity"), limit: field("int"), offset: field("int"), page: field("int"), total_pages: field("int"),
};
const socialProofTokenFields = {
    pool_id: field("string", true), token_address: field("address", true), is_active: field("bool"),
    reservation_pool_id: field("string", true), reservation_percentage: field("float"),
    reservation_status: field({ enum: ["active", "threshold_met", "inactive", "none"] }),
    total_reserved: field("quantity"), required_threshold: field("quantity"),
};
const selectedBadgeFields = {
    badge_id: field("string"), badge_name: field("string"), badge_icon_url: field("string", true),
    badge_media_url: field("string", true), platform_id: field("address"), badge_type: field("int"),
};
const searchPostFields = {
    post_id: field("address"), owner: field("address"), profile_id: field("string"), content: field("string"),
    post_type: field("string"), created_at: field("int"), deleted_at: field("int", true),
    reaction_count: field("quantity"), comment_count: field("quantity"), repost_count: field("quantity"),
    tips_received: field("quantity"), mydata_id: field("string", true), poc_id: field("string", true),
    revenue_redirect_to: field("address", true), revenue_redirect_percentage: field("quantity", true),
    poc_reasoning: field("string", true), poc_evidence_urls: field("json", true),
    poc_similarity_score: field("quantity", true), poc_media_type: field("int", true),
    poc_oracle_address: field("address", true), poc_analyzed_at: field("int", true),
    poc_outcome: field("int", true), poc_redirection_kind: field("int", true), poc_disputes_submitted: field("int"),
    composition_status: field("int", true), monetization_status: field("int", true), media_asset_ids: field("json", true),
    actor_address: field("address", true), sub_agent_id: field("string", true), action_identity_class: field("int", true),
};
const searchPlatformFields = {
    id: field("int"), platform_id: field("address"), name: field("string"), tagline: field("string"),
    description: field("string", true), logo: field("string", true), cover_photo: field("string", true),
    media_previews: field("json", true), developer_address: field("address"), moderators_group_id: field("string", true),
    badge_ledger_id: field("string", true), terms_of_service: field("string", true), privacy_policy: field("string", true),
    redirect_uri: field("string", true), platform_names: field("json", true), links: field("json", true),
    status: field("int"), release_date: field("string", true), shutdown_date: field("string", true),
    created_at: field("timestamp"), updated_at: field("timestamp"), is_approved: field("bool"),
    approval_changed_at: field("timestamp", true), approved_by: field("address", true),
    wants_dao_governance: field("bool", true), governance_registry_id: field("string", true),
    delegate_count: field("quantity", true), delegate_term_epochs: field("quantity", true),
    max_votes_per_user: field("quantity", true), proposal_submission_cost: field("quantity", true),
    quadratic_base_cost: field("quantity", true), quorum_votes: field("quantity", true),
    voting_period_epochs: field("quantity", true), version: field("quantity", true),
    primary_category: field("string"), secondary_category: field("string", true), deleted_at: field("timestamp", true),
};
const searchProfileFields = {
    id: field("int"), owner_address: field("address"), username: field("string"),
    display_name: field("string", true), bio: field("string", true), profile_photo: field("string", true),
    website: field("string", true), created_at: field("timestamp"), updated_at: field("timestamp"),
    cover_photo: field("string", true), profile_id: field("string", true), followers_count: field("int"),
    following_count: field("int"), blocked_count: field("int"), post_count: field("int"),
    birthdate: field("string", true), location: field("string", true), x_username: field("string", true),
    social_proof_token_address: field("address", true), reservation_pool_address: field("address", true),
    selected_badge_id: field("string", true), selected_ecosystem_badge_id: field("string", true),
    memory_account_id: field("string", true), ai_credit_balance_id: field("string", true),
    contract_version: field("quantity"), deleted_at: field("timestamp", true),
};
const followDetailFields = {
    id: field("int"), profile_id: field("string", true), owner_address: field("address"), username: field("string"),
    display_name: field("string", true), profile_photo: field("string", true), follows_back: field("bool"),
    is_following: field("bool"), reservation_pool: field({ object: {
        claimed_percentage: field("float"), is_active: field("bool"), total_reserved: field("quantity"),
        required_threshold: field("quantity"), pool_id: field("string", true),
    } }, true),
};
const SOCIAL_READ_RESPONSE_OVERRIDES: Record<string, Contract> = {
    social_list_profiles: { scope: "social:read", fields: {
        profiles: field({ array: {
            owner_address: field("address"), wallet_address: field("address"), username: field("string", true),
            fullname: field("string", true), profile_photo: field("string", true),
            social_proof_token: field({ object: socialProofTokenFields }, true),
            selected_badge: field({ object: selectedBadgeFields }, true),
        } }),
        pagination: field({ object: pageFields }),
    } },
    social_list_profile_followers: { scope: "social:read", fields: {
        profiles: field({ array: followDetailFields }), pagination: field({ object: pageFields }),
    } },
    social_list_profile_following: { scope: "social:read", fields: {
        profiles: field({ array: followDetailFields }), pagination: field({ object: pageFields }),
    } },
    social_list_profile_recommendations: { scope: "social:read", fields: {
        recommendations: field({ array: {
            id: field("int"), profile_id: field("string", true), owner_address: field("address"),
            username: field("string"), display_name: field("string", true), profile_photo: field("string", true),
            follows_back: field("bool"), is_following: field("bool"), mutual_count: field("int"),
            mutual_connections: field({ array: {
                owner_address: field("address"), username: field("string", true),
                display_name: field("string", true), profile_photo: field("string", true),
            } }), blocked_by_viewer: field("bool", true), blocked_by_subject: field("bool", true),
        } }),
        pagination: field({ object: pageFields }),
    } },
    social_list_profile_platform_events: { scope: "social:read", fields: {
        events: field({ array: {
            event_type: field("string"), platform_id: field("address"), created_at: field("timestamp"),
            event_id: field("string", true), event_data: field("json"),
        } }),
        total: field("quantity"),
    } },
    social_check_profile_blocked: { scope: "social:read", value: true, keys: ["is_blocked"] },
    social_check_either_profile_blocked: { scope: "social:read", value: true, keys: ["blocked"] },
    social_check_platform_blocked: { scope: "social:read", value: true, keys: ["is_blocked"] },
    social_list_revenue_leaderboard: { scope: "social:read", fields: {
        leaderboard: field({ array: {
            rank: field("int"), creator_address: field("address"), total_revenue: field("quantity"),
            revenue_breakdown: field({ object: {
                subscription_revenue: field("quantity"), mydata_revenue: field("quantity"),
                spt_revenue: field("quantity"), tips_revenue: field("quantity"), posts_revenue: field("quantity"),
            } }),
            growth_rate: field("float", true), transaction_count: field("quantity"), unique_payers: field("quantity"),
        } }),
        min_revenue: field("quantity"), limit: field("int"),
    } },
    social_list_unified_revenue: { scope: "social:read", fields: {
        revenue_records: field({ array: {
            revenue_source: field("string"), revenue_type: field("string"), creator_address: field("address"),
            platform_address: field("address", true), amount: field("quantity"), currency: field("string"),
            content_id: field("string", true), content_type: field("string", true), payer_address: field("address"),
            recipient_address: field("address"), revenue_time: field("int"), time: field("timestamp"),
            transaction_id: field("string"), organization_id: field("address", true),
        } }),
        total_count: field("quantity"), total_amount: field("quantity"), total_amount_formatted: field("string"),
        pagination: field({ object: pageFields }),
    } },
    social_list_treasury_history: { scope: "social:read", fields: {
        history: field({ array: {
            treasury_address: field("address"), updated_by: field("string"), updated_at: field("quantity"),
            time: field("int"), transaction_id: field("string"),
        } }),
        count: field("quantity"),
    } },
    // These contracts follow the concrete return types in Core's social-server
    // reader. The legacy generated manifest had copied PostBasicRow here, which
    // made valid collection responses fail closed at the MCP boundary.
    social_list_post_comments: { list: true, scope: "social:read", fields: {
        comment_id: field("address"), post_id: field("address"), parent_comment_id: field("address", true),
        owner: field("address"), profile_id: field("string"), content: field("string"), created_at: field("int"),
        reaction_count: field("int"), comment_count: field("int"), actor_address: field("address", true),
        sub_agent_id: field("string", true), action_identity_class: field("int", true),
    } },
    social_list_post_reactions: { list: true, scope: "social:read", fields: {
        user_address: field("address"), reaction_text: field("string"), created_at: field("int"),
        principal_owner: field("address", true), actor_address: field("address", true),
        sub_agent_id: field("string", true), action_identity_class: field("int", true),
    } },
    social_list_post_reposts: { list: true, scope: "social:read", fields: {
        repost_id: field("address"), original_post_id: field("address"), owner: field("address"),
        profile_id: field("string"), created_at: field("int"), actor_address: field("address", true),
        sub_agent_id: field("string", true), action_identity_class: field("int", true),
    } },
    social_list_post_poc_badges: { list: true, scope: "social:read", fields: {
        badge_id: field("string"), post_id: field("address"), media_type: field("int"), issued_by: field("address"),
        issued_at: field("int"), revoked: field("bool"), beneficiary_address: field("address", true),
        matched_anchor_id: field("string", true), media_index: field("int", true),
    } },
    social_list_post_revenue_redirections: { list: true, scope: "social:read", fields: {
        redirection_id: field("string"), accused_post_id: field("address"), original_post_id: field("address"),
        redirect_percentage: field("int"), similarity_score: field("int"), created_at: field("int"), removed: field("bool", true),
    } },
    social_list_post_transfers: { list: true, scope: "social:read", fields: {
        id: field("int"), object_id: field("address"), previous_owner: field("address"), new_owner: field("address"),
        is_post: field("bool"), transferred_at: field("int"), time: field("timestamp"), transaction_id: field("string"),
    } },
    social_list_post_reports: { list: true, scope: "social:read", fields: {
        id: field("int"), object_id: field("address"), is_comment: field("bool"), reporter: field("address"),
        reason_code: field("int"), description: field("string"), reported_at: field("int"), time: field("timestamp"),
        transaction_id: field("string"),
    } },
    social_list_post_moderation_events: { list: true, scope: "social:read", fields: {
        id: field("int"), object_id: field("address"), platform_id: field("address"), removed: field("bool"),
        moderated_by: field("address"), moderated_at: field("int"), time: field("timestamp"), transaction_id: field("string"),
    } },
    social_list_post_deletion_events: { list: true, scope: "social:read", fields: {
        id: field("int"), object_id: field("address"), owner: field("address"), profile_id: field("string"),
        is_post: field("bool"), post_type: field("string", true), post_id: field("address", true),
        deleted_at: field("int"), time: field("timestamp"), transaction_id: field("string"),
    } },
    social_get_post_promotion: { scope: "social:read", fields: {
        promotion_id: field("string"), post_id: field("address"), owner: field("address"), profile_id: field("string"),
        payment_per_view: field("quantity"), total_budget: field("quantity"), remaining_budget: field("quantity"), active: field("bool"),
        created_at: field("int"), views: field("quantity"), unique_viewers: field("quantity"), total_spent: field("quantity"),
        total_withdrawn: field("quantity"), platform_fee_total: field("quantity"), ecosystem_fee_total: field("quantity"),
        recipient_total: field("quantity"), first_view_at: field("int", true), last_view_at: field("int", true),
    } },
    social_list_platform_treasury_withdrawals: { scope: "social:read", fields: {
        withdrawals: field({ array: {
            id: field("int"), platform_id: field("address"), recipient: field("address"), amount: field("quantity"),
            reason_code: field("int"), executed_by: field("address"), timestamp: field("int"),
            created_at: field("timestamp"), event_id: field("string", true),
        } }),
    } },
    social_list_insurance_vault_transactions: { list: true, scope: "social:read", fields: {
        transaction_type: field("string"), amount: field("quantity"), balance_after: field("quantity"), timestamp_ms: field("int"),
    } },
    social_list_insurance_vault_exposures: { list: true, scope: "social:read", fields: {
        market_id: field("string"), option_id: field("int"), total_exposure: field("quantity"),
    } },
    social_list_vesting_wallet_events: { scope: "social:read", fields: {
        events: field({ array: {
            id: field("int"), wallet_id: field("string"), event_type: field("string"), owner_address: field("address"),
            coin_type: field("string"), amount: field("quantity"), remaining_balance: field("quantity", true),
            start_time: field("int", true), schedule_end: field("int", true), pieces: field("json", true),
            event_time: field("int"), time: field("timestamp"), transaction_id: field("string"),
        } }),
        total: field("quantity"),
        pagination: field({ object: {
            total: field("quantity"), limit: field("int"), offset: field("int"), page: field("int"), total_pages: field("int"),
        } }),
    } },
};

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The social reader returned malformed indexer data.");

function rowBound(args: Record<string, unknown>): number {
    const limit = args.limit;
    if (typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1) return Math.min(limit, 100);
    return 100;
}

function walk(value: unknown, depth = 0): void {
    if (depth > 8) throw fail();
    if (typeof value === "number") {
        if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value)) throw fail();
        return;
    }
    if (typeof value === "string" || typeof value === "boolean" || value === null) return;
    if (Array.isArray(value)) {
        if (value.length > 1000) throw fail();
        for (const item of value) walk(item, depth + 1);
        return;
    }
    if (value && typeof value === "object") {
        for (const nested of Object.values(value)) walk(nested, depth + 1);
    }
}

function checkValue(value: unknown, spec: Spec): void {
    if (value === null || value === undefined) {
        if (spec.nullable) return;
        throw fail();
    }
    const kind = spec.kind;
    if (kind === "blockEvent") {
        if (value !== "block" && value !== "unblock") throw fail();
        return;
    }
    if (kind === "string" || kind === "address" || kind === "timestamp") {
        if (typeof value !== "string" || value.length > 16384) throw fail();
        if (kind === "address" && !/^(0x)?[0-9a-fA-F]{1,64}$/.test(value)) throw fail();
        if (kind === "timestamp" && value.length > 0 && !Number.isFinite(Date.parse(value))) throw fail();
        return;
    }
    if (kind === "int") {
        if (!Number.isSafeInteger(value)) throw fail();
        return;
    }
    if (kind === "quantity") {
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return;
        if (typeof value === "string" && value.length <= 20 && /^(0|[1-9][0-9]*)$/.test(value)
            && BigInt(value) <= 18_446_744_073_709_551_615n) return;
        throw fail();
    }
    if (typeof kind === "object" && kind && "enum" in kind) {
        if (typeof value !== "string" || !kind.enum.includes(value)) throw fail();
        return;
    }
    if (kind === "float") {
        if (typeof value !== "number" || !Number.isFinite(value)) throw fail();
        return;
    }
    if (kind === "bool") {
        if (typeof value !== "boolean") throw fail();
        return;
    }
    if (kind === "strings") {
        if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || item.length > 2048)) throw fail();
        return;
    }
    if (kind === "json") {
        walk(value);
        return;
    }
    if (typeof kind === "object" && kind && "object" in kind) {
        checkObject(value, kind.object);
        return;
    }
    if (typeof kind === "object" && kind && "array" in kind) {
        if (!Array.isArray(value) || value.length > 100) throw fail();
        for (const item of value) checkObject(item, kind.array);
        return;
    }
    throw fail();
}

function checkObject(value: unknown, fields: Record<string, Spec>): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Record<string, unknown>;
    const allowed = new Set(Object.keys(fields));
    if (Object.keys(row).some((key) => !allowed.has(key))) throw fail();
    for (const [key, spec] of Object.entries(fields)) {
        if (!(key in row)) {
            if (!spec.nullable) throw fail();
            continue;
        }
        checkValue(row[key], spec);
    }
}

function enforceWrappedListBound(name: string, value: unknown, args: Record<string, unknown>): void {
    const listKey: Record<string, string> = {
        social_list_profiles: "profiles",
        social_list_profile_followers: "profiles",
        social_list_profile_following: "profiles",
        social_list_profile_recommendations: "recommendations",
        social_list_profile_platform_events: "events",
        social_list_platform_treasury_withdrawals: "withdrawals",
        social_list_vesting_wallet_events: "events",
        social_list_revenue_leaderboard: "leaderboard",
        social_list_unified_revenue: "revenue_records",
        social_list_treasury_history: "history",
    };
    const key = listKey[name];
    if (!key) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const rows = (value as Record<string, unknown>)[key];
    if (!Array.isArray(rows) || rows.length > rowBound(args)) throw fail();
}

function redactSocialSearchProfiles(value: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
    const profiles = value.profiles;
    if (!Array.isArray(profiles) || profiles.length > rowBound(args)) throw fail();
    const publicProfiles = profiles.map((profile) => {
        checkObject(profile, searchProfileFields);
        const publicProfile = { ...(profile as Record<string, unknown>) };
        delete publicProfile.memory_account_id;
        delete publicProfile.ai_credit_balance_id;
        delete publicProfile.contract_version;
        delete publicProfile.deleted_at;
        return publicProfile;
    });
    return { ...value, profiles: publicProfiles };
}

function normalizedObjectId(value: unknown): string | null {
    if (typeof value !== "string" || !/^(0x)?[0-9a-fA-F]{1,64}$/.test(value)) return null;
    return value.toLowerCase().replace(/^0x/, "").replace(/^0+(?=.)/, "");
}

function enforcePostIdentity(name: string, value: unknown, args: Record<string, unknown>): void {
    const fieldName: Record<string, string> = {
        social_get_post: "post_id",
        social_list_post_comments: "post_id",
        social_list_post_reposts: "original_post_id",
        social_get_post_promotion: "post_id",
        social_list_post_poc_badges: "post_id",
        social_list_post_revenue_redirections: "accused_post_id",
        social_list_post_transfers: "object_id",
        social_list_post_reports: "object_id",
        social_list_post_moderation_events: "object_id",
        social_list_post_deletion_events: "object_id",
        social_list_platform_treasury_withdrawals: "platform_id",
    };
    const key = fieldName[name];
    const wrapperField: Record<string, string> = {
        social_list_vesting_wallet_events: "events",
    };
    if (!key && !wrapperField[name]) return;
    const expected = normalizedObjectId(args.id);
    if (!expected) throw fail();
    const wrapped = wrapperField[name] && value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[wrapperField[name]] : undefined;
    const candidate = wrapped ?? value;
    const rows = Array.isArray(candidate) ? candidate : [candidate];
    for (const item of rows) {
        if (!item || typeof item !== "object" || Array.isArray(item)
            || normalizedObjectId((item as Record<string, unknown>)[key ?? "wallet_id"]) !== expected) throw fail();
    }
}

/** Public social reads stay indexer evidence. The supplied address is a filter, not session authority. */
export function sanitizeSocialRead(name: string, value: unknown, args: Record<string, unknown>, scope: string): unknown {
    const contract = SOCIAL_READ_RESPONSE_OVERRIDES[name] ?? (SOCIAL_READ_CONTRACTS as Record<string, Contract>)[name];
    if (!contract || scope !== "social:read" || contract.scope !== "social:read") {
        throw new McpRuntimeError("CAPABILITY_DENIED", "This social read is not available for the current scope.");
    }
    if (contract.value) {
        if (value === null && contract.nullable) return value;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
        const row = value as Record<string, unknown>;
        const keys = [...(contract.keys ?? [])].sort();
        const actual = Object.keys(row).sort();
        if (keys.length === 0 || actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw fail();
        walk(row);
        enforceWrappedListBound(name, row, args);
        enforcePostIdentity(name, row, args);
        if (name === "social_search") {
            const posts = row.posts;
            const platforms = row.platforms;
            if (!Array.isArray(posts) || posts.length > rowBound(args)
                || !Array.isArray(platforms) || platforms.length > rowBound(args)
                || !Array.isArray(row.profiles) || row.profiles.length > rowBound(args)
                || !Number.isSafeInteger(row.platforms_count) || (row.platforms_count as number) < 0) throw fail();
            for (const post of posts) checkObject(post, searchPostFields);
            for (const platform of platforms) checkObject(platform, searchPlatformFields);
            return redactSocialSearchProfiles(row, args);
        }
        return row;
    }
    if (contract.list) {
        if (!Array.isArray(value) || value.length > rowBound(args)) throw fail();
        for (const item of value) checkObject(item, contract.fields ?? {});
        enforceWrappedListBound(name, value, args);
        enforcePostIdentity(name, value, args);
        if (name === "social_list_governance_proposals") {
            const seen = new Set<string>();
            let previousTime = Number.POSITIVE_INFINITY;
            let previousId = "";
            const expectedSubmitter = args.submitter === undefined ? null : normalizedObjectId(args.submitter);
            if (args.submitter !== undefined && expectedSubmitter === null) throw fail();
            for (const item of value as Record<string, unknown>[]) {
                if (typeof item.id !== "string" || seen.has(item.id)
                    || !Number.isInteger(item.status) || (item.status as number) < 0 || (item.status as number) > 6
                    || !Number.isInteger(item.proposal_type) || (item.proposal_type as number) < 0 || (item.proposal_type as number) > 3
                    || (args.status !== undefined && item.status !== args.status)
                    || (args.proposal_type !== undefined && item.proposal_type !== args.proposal_type)
                    || (expectedSubmitter !== null && normalizedObjectId(item.submitter) !== expectedSubmitter)) throw fail();
                const time = item.submission_time as number;
                if (time > previousTime || (time === previousTime && item.id.localeCompare(previousId) < 0)) throw fail();
                seen.add(item.id);
                previousTime = time;
                previousId = item.id;
            }
        }
        if (name === "social_list_profile_badges") {
            const seen = new Set<string>();
            let previousTime = Number.POSITIVE_INFINITY;
            let previousBadgeId = "";
            for (const item of value as Record<string, unknown>[]) {
                if (typeof item.badge_id !== "string" || seen.has(item.badge_id)
                    || item.revoked !== false || !Number.isSafeInteger(item.assigned_at)) throw fail();
                const time = item.assigned_at as number;
                if (time > previousTime || (time === previousTime && item.badge_id < previousBadgeId)) throw fail();
                seen.add(item.badge_id);
                previousTime = time;
                previousBadgeId = item.badge_id;
            }
        }
        return value;
    }
    checkObject(value, contract.fields ?? {});
    enforceWrappedListBound(name, value, args);
    enforcePostIdentity(name, value, args);
    return value;
}
