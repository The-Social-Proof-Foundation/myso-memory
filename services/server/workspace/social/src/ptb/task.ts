import type {
    SocialChainConfig,
    TaskAcceptParams,
    TaskCancelOfferParams,
    TaskCreateParams,
    TaskDeliverParams,
    TaskPermissionlessParams,
    TaskRefundProposalParams,
    TaskReleaseParams,
    TaskReviewParams,
    TaskSellerParams,
    TaskSettleParams,
} from "../types.js";
import type { BuildTxContext } from "./post.js";
import { MYSO_CLOCK, optAddress, resolvePlatformObjectId } from "./helpers.js";

const U64_MAX = (1n << 64n) - 1n;

function taskConfigId(chain: SocialChainConfig): string {
    if (!chain.taskConfigId?.trim()) {
        throw new TypeError("taskConfigId is required for task actions");
    }
    return chain.taskConfigId;
}

function target(chain: SocialChainConfig, fn: string): string {
    return `${chain.packageId}::agent_task::${fn}`;
}

function clock(ctx: BuildTxContext, tx: any): unknown {
    return tx.object(ctx.chain.clockId ?? MYSO_CLOCK);
}

function u64(value: string, label: string): string {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64_MAX) {
        throw new TypeError(`${label} must be an unsigned u64 decimal string`);
    }
    return value;
}

function digestBytes(value: string, label: string): number[] {
    if (!/^[0-9a-f]{64}$/.test(value)) {
        throw new TypeError(`${label} must be 64 lowercase hex characters`);
    }
    return Array.from({ length: 32 }, (_, index) =>
        Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
    );
}

/** Buyer funds an offer. The acting account (`ctx.memoryAccountId`) is the buyer. */
export function buildCreateTaskTx(ctx: BuildTxContext, params: TaskCreateParams): any {
    const amount = u64(params.amountMist, "amountMist");
    if (BigInt(amount) === 0n) throw new TypeError("amountMist must be greater than zero");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: target(ctx.chain, "create_task"),
        arguments: [
            tx.object(taskConfigId(ctx.chain)),
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.sellerAccountId),
            tx.object(params.sellerAgentId),
            tx.object(params.paymentCoinId),
            tx.pure("u64", amount),
            tx.pure("vector<u8>", digestBytes(params.scopeDigestHex, "scopeDigestHex")),
            tx.pure("string", params.title),
            tx.pure("u64", u64(params.acceptWindowMs, "acceptWindowMs")),
            tx.pure("u64", u64(params.deliveryWindowMs, "deliveryWindowMs")),
            tx.pure("u64", u64(params.settleWindowMs, "settleWindowMs")),
            optAddress(tx, params.roomGroupId),
            optAddress(tx, params.platformId),
            clock(ctx, tx),
        ],
    });
    return tx;
}

/** Seller approves the exact terms. The acting account is the seller's. */
export function buildAcceptTaskTx(ctx: BuildTxContext, params: TaskAcceptParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: target(ctx.chain, "accept_task"),
        arguments: [
            tx.object(taskConfigId(ctx.chain)),
            tx.object(params.taskId),
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.sellerAgentId),
            tx.pure("vector<u8>", digestBytes(params.termsDigestHex, "termsDigestHex")),
            clock(ctx, tx),
        ],
    });
    return tx;
}

export function buildDeclineTaskTx(ctx: BuildTxContext, params: TaskSellerParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: target(ctx.chain, "decline_task"),
        arguments: [
            tx.object(params.taskId),
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.sellerAgentId),
            clock(ctx, tx),
        ],
    });
    return tx;
}

export function buildCancelOfferTx(ctx: BuildTxContext, params: TaskCancelOfferParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: target(ctx.chain, "cancel_offer"),
        arguments: [
            tx.object(params.taskId),
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            clock(ctx, tx),
        ],
    });
    return tx;
}

function permissionless(fn: "expire_offer" | "refund_task") {
    return (ctx: BuildTxContext, params: TaskPermissionlessParams): any => {
        const tx = new ctx.Transaction();
        tx.moveCall({
            target: target(ctx.chain, fn),
            arguments: [tx.object(params.taskId), clock(ctx, tx)],
        });
        return tx;
    };
}

export const buildExpireOfferTx = permissionless("expire_offer");
export const buildRefundTaskTx = permissionless("refund_task");

export function buildDeliverTaskTx(ctx: BuildTxContext, params: TaskDeliverParams): any {
    if (new TextEncoder().encode(params.uri).length > 2048) {
        throw new TypeError("uri exceeds 2048 bytes");
    }
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: target(ctx.chain, "mark_delivered"),
        arguments: [
            tx.object(taskConfigId(ctx.chain)),
            tx.object(params.taskId),
            tx.object(params.sellerAgentId),
            tx.pure("vector<u8>", digestBytes(params.digestHex, "digestHex")),
            tx.pure("string", params.uri),
            clock(ctx, tx),
        ],
    });
    return tx;
}

/** Buyer pays out. The acting account is the buyer's. */
export function buildSettleTaskTx(ctx: BuildTxContext, params: TaskSettleParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: target(ctx.chain, "settle_task"),
        arguments: [
            tx.object(taskConfigId(ctx.chain)),
            tx.object(params.taskId),
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.sellerAccountId),
            tx.object(resolvePlatformObjectId(ctx.chain, params.platformObjectId)),
            clock(ctx, tx),
        ],
    });
    return tx;
}

/** Permissionless once `settle_deadline + release_grace` has passed. */
export function buildReleaseTaskTx(ctx: BuildTxContext, params: TaskReleaseParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: target(ctx.chain, "release_task"),
        arguments: [
            tx.object(taskConfigId(ctx.chain)),
            tx.object(params.taskId),
            tx.object(params.buyerAccountId),
            tx.object(params.sellerAccountId),
            tx.object(resolvePlatformObjectId(ctx.chain, params.platformObjectId)),
            clock(ctx, tx),
        ],
    });
    return tx;
}

function refundProposal(fn: "propose_refund" | "accept_refund" | "reject_refund" | "withdraw_refund") {
    return (ctx: BuildTxContext, params: TaskRefundProposalParams): any => {
        const tx = new ctx.Transaction();
        tx.moveCall({
            target: target(ctx.chain, fn),
            arguments: [
                tx.object(params.taskId),
                tx.object(ctx.chain.memoryConfigId),
                tx.object(params.buyerAccountId),
                tx.object(params.sellerAgentId),
                clock(ctx, tx),
            ],
        });
        return tx;
    };
}

export const buildProposeRefundTx = refundProposal("propose_refund");
export const buildAcceptRefundTx = refundProposal("accept_refund");
export const buildRejectRefundTx = refundProposal("reject_refund");
export const buildWithdrawRefundTx = refundProposal("withdraw_refund");

function assertStars(stars: number): void {
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        throw new TypeError("stars must be an integer from 1 to 5");
    }
}

/**
 * One action, three Move entrypoints: the builder picks `review_seller`,
 * `review_buyer_agent` or `review_buyer_principal` from the rater role and whether the
 * buyer acted through an agent. The contract still rejects a mismatched target.
 */
export function buildReviewTaskTx(ctx: BuildTxContext, params: TaskReviewParams): any {
    assertStars(params.stars);
    const tx = new ctx.Transaction();
    const config = tx.object(taskConfigId(ctx.chain));
    const task = tx.object(params.taskId);
    const stars = tx.pure("u8", params.stars);
    const when = clock(ctx, tx);

    if (params.raterRole === "buyer") {
        if (!params.sellerAccountId) {
            throw new TypeError("sellerAccountId is required when the buyer rates the seller");
        }
        tx.moveCall({
            target: target(ctx.chain, "review_seller"),
            arguments: [
                config,
                task,
                tx.object(ctx.chain.memoryConfigId),
                tx.object(params.buyerAccountId),
                tx.object(params.sellerAccountId),
                tx.object(params.sellerAgentId),
                stars,
                when,
            ],
        });
        return tx;
    }

    if (params.buyerAgentId) {
        tx.moveCall({
            target: target(ctx.chain, "review_buyer_agent"),
            arguments: [
                config,
                task,
                tx.object(params.buyerAccountId),
                tx.object(params.buyerAgentId),
                tx.object(params.sellerAgentId),
                stars,
                when,
            ],
        });
        return tx;
    }

    tx.moveCall({
        target: target(ctx.chain, "review_buyer_principal"),
        arguments: [
            config,
            task,
            tx.object(params.buyerAccountId),
            tx.object(params.sellerAgentId),
            stars,
            when,
        ],
    });
    return tx;
}
