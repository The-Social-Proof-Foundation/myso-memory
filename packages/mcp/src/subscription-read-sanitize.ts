import { McpRuntimeError } from "./errors.js";

export interface SubscriptionReadIdentity { accountId: string; agentObjectId: string }

function readObject(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid object.`);
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length !== fields.length || fields.some((field) => !(field in object))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an unexpected field set.`);
    return object;
}
function readAddress(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid address.`);
    return value;
}
function readU64(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid decimal u64.`);
    return value;
}
function readCoinType(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 512 || value !== value.trim()) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid coin type.`);
    return value;
}
function readDigest(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid transaction digest.`);
    return value;
}
function normalizeHostedId(value: string): string { return value.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }

export function sanitizeSubscriptionRead(name: string, args: Record<string, unknown>, value: unknown, identity: SubscriptionReadIdentity): unknown {
    if (!name.startsWith("subscription_")) return value;
    const label = name.replaceAll("_", " ");
    const metadataFields = ["subscriptionId", "serviceId", "planId", "subscriber", "coinType", "createdAtMs", "expiresAtMs", "renewalCount", "autoRenew", "tierLevel", "planPlatformId", "objectVersion", "renewalBalanceBaseUnits", "balanceRead"] as const;
    const readTerms = (input: unknown): Record<string, unknown> => {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid terms.`);
        const terms = input as Record<string, unknown>;
        const allowed = new Set(["planId", "expectedProfileOwner", "coinType", "priceBaseUnits", "durationMs", "tierLevel", "planPlatformId"]);
        if (Object.keys(terms).some((key) => !allowed.has(key)) || !["planId", "expectedProfileOwner", "coinType", "priceBaseUnits", "durationMs"].every((key) => key in terms)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an unexpected terms field set.`);
        readAddress(terms.planId, label); readAddress(terms.expectedProfileOwner, label); readCoinType(terms.coinType, label); readU64(terms.priceBaseUnits, label); readU64(terms.durationMs, label);
        if ("tierLevel" in terms && terms.tierLevel !== null) readU64(terms.tierLevel, label);
        if ("planPlatformId" in terms && terms.planPlatformId !== null) readAddress(terms.planPlatformId, label);
        return terms;
    };
    const readMetadata = (input: unknown): void => {
        const metadata = readObject(input, label, ["title", "description", "source"]);
        const preview = (value: unknown): void => {
            const row = readObject(value, label, ["text", "totalCharacters", "truncated", "unit"]);
            const characters = typeof row.text === "string" ? Array.from(row.text).length : -1;
            if (typeof row.text !== "string" || characters > 256 || !Number.isSafeInteger(row.totalCharacters) || (row.totalCharacters as number) < characters || typeof row.truncated !== "boolean" || row.truncated !== ((row.totalCharacters as number) > characters) || row.unit !== "unicode_scalar") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid seller metadata.`);
        };
        preview(metadata.title);
        if (metadata.description !== null) {
            const row = readObject(metadata.description, label, ["text", "totalCharacters", "truncated", "unit"]);
            const characters = typeof row.text === "string" ? Array.from(row.text).length : -1;
            if (typeof row.text !== "string" || characters > 1024 || !Number.isSafeInteger(row.totalCharacters) || (row.totalCharacters as number) < characters || typeof row.truncated !== "boolean" || row.truncated !== ((row.totalCharacters as number) > characters) || row.unit !== "unicode_scalar") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid seller metadata.`);
        }
        if (metadata.source !== "seller_supplied_on_chain") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an unsupported metadata source.`);
    };
    const readSubscription = (input: unknown, withBalance: boolean): Record<string, unknown> => {
        const fields = withBalance ? [...metadataFields, "balanceObservedAtMs"] : [...metadataFields];
        const row = readObject(input, label, fields);
        for (const key of ["subscriptionId", "serviceId", "planId", "subscriber"] as const) readAddress(row[key], label);
        readCoinType(row.coinType, label);
        for (const key of ["createdAtMs", "expiresAtMs", "renewalCount", "objectVersion"] as const) readU64(row[key], label);
        if (typeof row.autoRenew !== "boolean" || !(row.tierLevel === null || typeof row.tierLevel === "string") || !(row.planPlatformId === null || typeof row.planPlatformId === "string")) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid subscription access fields.`);
        if (row.tierLevel !== null) readU64(row.tierLevel, label);
        if (row.planPlatformId !== null) readAddress(row.planPlatformId, label);
        if (withBalance) {
            readU64(row.renewalBalanceBaseUnits, label);
            if (row.balanceRead !== true || !Number.isSafeInteger(row.balanceObservedAtMs) || (row.balanceObservedAtMs as number) < 0) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid live balance evidence.`);
        } else if (row.renewalBalanceBaseUnits !== null || row.balanceRead !== false) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read unexpectedly claims a balance read.`);
        return row;
    };
    const validatePage = (row: Record<string, unknown>, items: unknown[]): void => {
        if (typeof row.hasNextPage !== "boolean" || !(row.nextCursor === null || typeof row.nextCursor === "string") || row.source !== "configured_fullnode") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid page.`);
        const limit = typeof args.limit === "number" ? args.limit : 20;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || items.length > limit) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid page size.`);
        if (row.nextCursor !== null) {
            readAddress(row.nextCursor, label);
            if (args.cursor !== undefined && normalizeHostedId(row.nextCursor) === normalizeHostedId(String(args.cursor))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read did not advance its cursor.`);
        }
        if ((row.hasNextPage && row.nextCursor === null) || (!row.hasNextPage && row.nextCursor !== null)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned inconsistent pagination.`);
    };
    const readQuote = (input: unknown, renewal: boolean): Record<string, unknown> => {
        const fields = renewal
            ? ["serviceId", "serviceObjectVersion", "paymentRecipient", "terms", "planMetadata", "planActive", "serviceActive", "maxRenewalPeriods", "deploymentEnabled", "quotedAtMs", "source", "atomicTermsPinnedAtExecution", "retainedAccess", "subscription", "nativeRenewalRetainsStoredAccess"]
            : ["serviceId", "serviceObjectVersion", "paymentRecipient", "terms", "planMetadata", "planActive", "serviceActive", "maxRenewalPeriods", "deploymentEnabled", "quotedAtMs", "source", "atomicTermsPinnedAtExecution"];
        const row = readObject(input, label, fields);
        readAddress(row.serviceId, label); readU64(row.serviceObjectVersion, label); readAddress(row.paymentRecipient, label);
        const terms = readTerms(row.terms);
        readMetadata(row.planMetadata);
        readU64(row.maxRenewalPeriods, label);
        if (typeof row.planActive !== "boolean" || typeof row.serviceActive !== "boolean" || typeof row.deploymentEnabled !== "boolean" || !Number.isSafeInteger(row.quotedAtMs) || row.source !== "configured_fullnode" || row.atomicTermsPinnedAtExecution !== true) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid quote evidence.`);
        if (args.serviceId !== undefined && normalizeHostedId(readAddress(row.serviceId, label)) !== normalizeHostedId(String(args.serviceId))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned another service.`);
        if (args.planId !== undefined && normalizeHostedId(readAddress(terms.planId, label)) !== normalizeHostedId(String(args.planId))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned another plan.`);
        if (renewal) {
            const retained = readObject(row.retainedAccess, label, ["tierLevel", "platformId", "source"]);
            if (!(retained.tierLevel === null || typeof retained.tierLevel === "string") || !(retained.platformId === null || typeof retained.platformId === "string") || retained.source !== "immutable_subscription_fields" || row.nativeRenewalRetainsStoredAccess !== true) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid retained-access terms.`);
            if (retained.tierLevel !== null) readU64(retained.tierLevel, label);
            if (retained.platformId !== null) readAddress(retained.platformId, label);
            const subscription = readSubscription(row.subscription, false);
            if (normalizeHostedId(String(subscription.serviceId)) !== normalizeHostedId(String(row.serviceId)) || normalizeHostedId(String(subscription.planId)) !== normalizeHostedId(String(terms.planId)) || subscription.coinType !== terms.coinType || normalizeHostedId(String(subscription.subscriptionId)) !== normalizeHostedId(String(args.id))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned a mismatched subscription.`);
        }
        return row;
    };
    if (name === "subscription_get_plan_quote") return readQuote(value, false);
    if (name === "subscription_get_renewal_quote") return readQuote(value, true);
    if (name === "subscription_get") {
        const row = readSubscription(value, true);
        if (normalizeHostedId(String(row.subscriptionId)) !== normalizeHostedId(String(args.id))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned a different subscription.`);
        return row;
    }
    if (name === "subscription_list") {
        const row = readObject(value, label, ["items", "nextCursor", "hasNextPage", "owner", "source"]);
        if (!Array.isArray(row.items)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid page.`);
        readAddress(row.owner, label);
        validatePage(row, row.items);
        for (const item of row.items) readSubscription(item, false);
        return row;
    }
    if (name === "subscription_list_plans") {
        const row = readObject(value, label, ["serviceId", "paymentRecipient", "profileOwner", "items", "nextCursor", "hasNextPage", "source"]);
        if (!Array.isArray(row.items)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid page.`);
        for (const key of ["serviceId", "paymentRecipient", "profileOwner"] as const) readAddress(row[key], label);
        if (args.serviceId !== undefined && normalizeHostedId(String(row.serviceId)) !== normalizeHostedId(String(args.serviceId))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned another service.`);
        validatePage(row, row.items);
        for (const item of row.items) {
            const plan = readObject(item, label, ["terms", "active", "planMetadata"]);
            readTerms(plan.terms); if (typeof plan.active !== "boolean") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid plan status.`); readMetadata(plan.planMetadata);
        }
        return row;
    }
    if (name === "subscription_get_receipt") {
        const row = readObject(value, label, ["digest", "registryAction", "accountId", "agentId", "status", "checkpoint", "events", "preparedContext", "evidenceSource", "currentAccess"]);
        readDigest(row.digest, label);
        const actions = ["subscription.subscribe_to_plan.v1", "subscription.renew_subscription.v1", "subscription.cancel_subscription.v1", "subscription.enable_auto_renew.v1", "subscription.disable_auto_renew.v1", "subscription.change_service_payment_recipient.v1"];
        if (row.digest !== args.id || !actions.includes(String(row.registryAction)) || row.accountId !== identity.accountId || normalizeHostedId(readAddress(row.agentId, label)) !== normalizeHostedId(identity.agentObjectId) || !["finalized", "executed", "failed", "unknown"].includes(String(row.status)) || !(row.checkpoint === null || typeof row.checkpoint === "string") || !Array.isArray(row.events) || row.events.length > 1 || ((row.status === "finalized" || row.status === "executed") !== (row.events.length === 1)) || row.evidenceSource !== "configured_fullnode_and_scoped_preparation" || row.currentAccess !== "not_checked") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read did not match the authenticated transaction.`);
        if (row.checkpoint !== null) readU64(row.checkpoint, label);
        const context = row.preparedContext;
        if (!context || typeof context !== "object" || Array.isArray(context)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid prepared context.`);
        const contextRow = context as Record<string, unknown>;
        const contextFields: Record<string, string[]> = {
            "subscription.subscribe_to_plan.v1": ["serviceId", "executionPlatformId", "autoRenew", "coinType", "planId", "profileOwner", "priceBaseUnits", "durationMs", "prepaidRenewalPeriods", "totalCommittedBaseUnits"],
            "subscription.renew_subscription.v1": ["serviceId", "executionPlatformId", "subscriptionId", "coinType", "planId", "profileOwner", "priceBaseUnits", "durationMs", "prepaidRenewalPeriods", "totalCommittedBaseUnits"],
            "subscription.cancel_subscription.v1": ["serviceId", "executionPlatformId", "subscriptionId", "coinType"],
            "subscription.enable_auto_renew.v1": ["serviceId", "executionPlatformId", "subscriptionId", "autoRenew"],
            "subscription.disable_auto_renew.v1": ["serviceId", "executionPlatformId", "subscriptionId", "autoRenew"],
            "subscription.change_service_payment_recipient.v1": ["serviceId", "executionPlatformId", "newRecipient"],
        };
        const expectedContext = contextFields[String(row.registryAction)];
        if (!expectedContext || Object.keys(contextRow).length !== expectedContext.length || expectedContext.some((key) => !(key in contextRow))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned unexpected prepared context fields.`);
        for (const key of ["serviceId", "executionPlatformId"] as const) readAddress(contextRow[key], label);
        for (const key of ["subscriptionId", "planId", "profileOwner", "newRecipient"] as const) if (contextRow[key] !== undefined) readAddress(contextRow[key], label);
        for (const key of ["priceBaseUnits", "durationMs", "prepaidRenewalPeriods", "totalCommittedBaseUnits"] as const) if (contextRow[key] !== undefined) readU64(contextRow[key], label);
        if (contextRow.coinType !== undefined) readCoinType(contextRow.coinType, label);
        if (contextRow.autoRenew !== undefined && typeof contextRow.autoRenew !== "boolean") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid action context.`);
        for (const rawEvent of row.events) {
            const event = rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent) ? rawEvent as Record<string, unknown> : null;
            if (!event || typeof event.kind !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid event.`);
            const eventFields: Record<string, string[]> = {
                ProfileSubscriptionCreatedEvent: ["kind", "subscriptionId", "subscriber", "coinType", "priceBaseUnits", "expiresAtMs", "platformFeeBaseUnits", "ecosystemFeeBaseUnits", "creatorAmountBaseUnits", "accessTierLevel", "accessPlatformId", "durationMs"],
                ProfileSubscriptionRenewedEvent: ["kind", "subscriptionId", "subscriber", "coinType", "priceBaseUnits", "expiresAtMs", "platformFeeBaseUnits", "ecosystemFeeBaseUnits", "creatorAmountBaseUnits", "accessTierLevel", "accessPlatformId", "durationMs"],
                ProfileSubscriptionCancelledEvent: ["kind", "subscriptionId", "subscriber", "refundBaseUnits", "coinType", "coinTypeSource", "objectDeleted"],
                SubscriptionAutoRenewUpdatedEvent: ["kind", "subscriptionId", "subscriber", "autoRenew", "timestampMs", "newFundingBaseUnits"],
                ServicePaymentRecipientUpdatedEvent: ["kind", "serviceId", "previousRecipient", "newRecipient", "updatedBy", "timestampMs"],
            };
            const expectedFields = eventFields[event.kind];
            if (!expectedFields || Object.keys(event).length !== expectedFields.length || expectedFields.some((key) => !(key in event))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an unexpected event shape.`);
            for (const key of ["subscriptionId", "subscriber", "serviceId", "previousRecipient", "newRecipient", "updatedBy"] as const) if (event[key] !== undefined) readAddress(event[key], label);
            for (const key of ["priceBaseUnits", "expiresAtMs", "platformFeeBaseUnits", "ecosystemFeeBaseUnits", "creatorAmountBaseUnits", "durationMs", "refundBaseUnits", "timestampMs", "newFundingBaseUnits"] as const) if (event[key] !== undefined) readU64(event[key], label);
            if (event.coinType !== undefined) readCoinType(event.coinType, label);
            if (event.accessTierLevel !== undefined && event.accessTierLevel !== null) readU64(event.accessTierLevel, label);
            if (event.accessPlatformId !== undefined && event.accessPlatformId !== null) readAddress(event.accessPlatformId, label);
            if (event.objectDeleted !== undefined && event.objectDeleted !== true) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an unverified cancellation event.`);
            if (event.coinTypeSource !== undefined && event.coinTypeSource !== "scoped_exact_input_preparation") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an unsupported currency source.`);
            if (event.autoRenew !== undefined && typeof event.autoRenew !== "boolean") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned invalid renewal state.`);
        }
        if (row.events.length === 1) {
            const expectedEvent: Record<string, string> = {
                "subscription.subscribe_to_plan.v1": "ProfileSubscriptionCreatedEvent",
                "subscription.renew_subscription.v1": "ProfileSubscriptionRenewedEvent",
                "subscription.cancel_subscription.v1": "ProfileSubscriptionCancelledEvent",
                "subscription.enable_auto_renew.v1": "SubscriptionAutoRenewUpdatedEvent",
                "subscription.disable_auto_renew.v1": "SubscriptionAutoRenewUpdatedEvent",
                "subscription.change_service_payment_recipient.v1": "ServicePaymentRecipientUpdatedEvent",
            };
            if ((row.events[0] as Record<string, unknown>).kind !== expectedEvent[String(row.registryAction)]) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an event for another action.`);
        }
        return row;
    }
    throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read has no response validator.`);
}
