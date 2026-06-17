/**
 * Social action PTB build + execute for memory-server /api/social/* routes.
 */

import { Ed25519Keypair } from "@socialproof/myso/keypairs/ed25519";
import { decodeMySoPrivateKey } from "@socialproof/myso/cryptography";
import { Transaction } from "@socialproof/myso/transactions";
import { MySoJsonRpcClient, getJsonRpcFullnodeUrl } from "@socialproof/myso/jsonRpc";
import type { SocialChainConfig, SocialExecuteAction } from "@socialproof/social";
import {
    buildCreatePostTx,
    buildCreateCommentTx,
    buildReactToPostTx,
    buildReactToCommentTx,
    buildCreateRepostTx,
    buildDeletePostTx,
    buildDeleteCommentTx,
} from "@socialproof/social/ptb";
import { parseSocialTxEffects } from "@socialproof/social";

const MYSO_NETWORK_RAW = process.env.MYSO_NETWORK || "mainnet";
const FILE_STORAGE_NETWORK: "mainnet" | "testnet" =
    MYSO_NETWORK_RAW === "mainnet" ? "mainnet" : "testnet";
const MYSO_RPC_URL =
    process.env.MYSO_RPC_URL || getJsonRpcFullnodeUrl(FILE_STORAGE_NETWORK);

const mysoClient = new MySoJsonRpcClient({
    url: MYSO_RPC_URL,
    network: FILE_STORAGE_NETWORK,
});

const ENOKI_API_KEY = process.env.ENOKI_API_KEY?.trim() || "";
const ENOKI_API_BASE_URL =
    process.env.ENOKI_API_BASE_URL?.trim() || "https://api.enoki.mysocial.network/v1";
const ENOKI_NETWORK = process.env.ENOKI_NETWORK?.trim() || FILE_STORAGE_NETWORK;
const ENOKI_FALLBACK_TO_DIRECT_SIGN =
    process.env.ENOKI_FALLBACK_TO_DIRECT_SIGN !== "0";

interface EnokiSponsorResponse {
    bytes: string;
    digest: string;
}

interface EnokiExecuteResponse {
    digest: string;
}

async function callEnoki<T>(path: string, payload: unknown): Promise<T> {
    if (!ENOKI_API_KEY) throw new Error("ENOKI_API_KEY is not configured");
    const resp = await fetch(`${ENOKI_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ENOKI_API_KEY}`,
        },
        body: JSON.stringify(payload),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Enoki API error (${resp.status}): ${text}`);
    return (JSON.parse(text) as { data: T }).data;
}

async function executeWithEnokiSponsor(
    tx: Transaction,
    signer: Ed25519Keypair,
): Promise<string> {
    if (!ENOKI_API_KEY) {
        const direct = await mysoClient.signAndExecuteTransaction({ signer, transaction: tx });
        return direct.digest;
    }
    try {
        const txKindBytes = await tx.build({
            client: mysoClient as any,
            onlyTransactionKind: true,
        });
        const sponsored = await callEnoki<EnokiSponsorResponse>(
            "/transaction-blocks/sponsor",
            {
                network: ENOKI_NETWORK,
                transactionBlockKindBytes: Buffer.from(txKindBytes).toString("base64"),
                sender: signer.toMySoAddress(),
            },
        );
        const signature = await signer.signTransaction(
            new Uint8Array(Buffer.from(sponsored.bytes, "base64")),
        );
        const encodedDigest = encodeURIComponent(sponsored.digest);
        const executed = await callEnoki<EnokiExecuteResponse>(
            `/transaction-blocks/sponsor/${encodedDigest}`,
            { digest: sponsored.digest, signature: signature.signature },
        );
        return executed.digest;
    } catch (err: any) {
        if (!ENOKI_FALLBACK_TO_DIRECT_SIGN) throw err;
        const direct = await mysoClient.signAndExecuteTransaction({ signer, transaction: tx });
        return direct.digest;
    }
}

function keypairFromHex(privateKeyHex: string): Ed25519Keypair {
    const { secretKey } = decodeMySoPrivateKey(privateKeyHex);
    return Ed25519Keypair.fromSecretKey(secretKey);
}

export function loadSocialChainConfig(): SocialChainConfig {
    const required = (name: string): string => {
        const v = process.env[name]?.trim();
        if (!v) throw new Error(`${name} must be set for social actions`);
        return v;
    };
    return {
        packageId: required("MEMORY_PACKAGE_ID"),
        usernameRegistryId: required("USERNAME_REGISTRY_ID"),
        platformRegistryId: required("PLATFORM_REGISTRY_ID"),
        platformObjectId: required("PLATFORM_OBJECT_ID"),
        blockListRegistryId: required("BLOCK_LIST_REGISTRY_ID"),
        postConfigId: required("POST_CONFIG_ID"),
        mydataRegistryId: required("MYDATA_REGISTRY_ID"),
    };
}

export interface SocialExecuteRequest {
    action: SocialExecuteAction;
    params: Record<string, unknown>;
    memoryAccountId: string;
    senderPrivateKey: string;
    ownerPrivateKey?: string;
    gasBudget?: number;
}

export async function executeSocialAction(req: SocialExecuteRequest) {
    const chain = loadSocialChainConfig();
    const ctx = {
        Transaction,
        chain,
        memoryAccountId: req.memoryAccountId,
    };

    const isDelete =
        req.action === "delete_post" || req.action === "delete_comment";
    const signerHex = isDelete ? req.ownerPrivateKey : req.senderPrivateKey;
    if (!signerHex) {
        throw new Error(
            isDelete
                ? "ownerPrivateKey required for delete actions"
                : "senderPrivateKey required",
        );
    }
    const signer = keypairFromHex(signerHex);

    let tx: Transaction;
    switch (req.action) {
        case "create_post":
            tx = buildCreatePostTx(ctx, req.params as any);
            break;
        case "create_comment":
            tx = buildCreateCommentTx(ctx, req.params as any);
            break;
        case "react_to_post":
            tx = buildReactToPostTx(ctx, req.params as any);
            break;
        case "react_to_comment":
            tx = buildReactToCommentTx(ctx, req.params as any);
            break;
        case "create_repost":
            tx = buildCreateRepostTx(ctx, req.params as any);
            break;
        case "delete_post":
            tx = buildDeletePostTx(chain, String(req.params.postId), Transaction);
            break;
        case "delete_comment":
            tx = buildDeleteCommentTx(
                chain,
                String(req.params.postId),
                String(req.params.commentId),
                Transaction,
            );
            break;
        default:
            throw new Error(`Unknown social action: ${req.action}`);
    }

    if (req.gasBudget) {
        tx.setGasBudget(req.gasBudget);
    } else {
        tx.setGasBudget(50_000_000);
    }

    const digest = await executeWithEnokiSponsor(tx, signer);
    const txResult = await mysoClient.waitForTransaction({
        digest,
        options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });
    return parseSocialTxEffects(digest, txResult);
}

export async function buildSocialTransaction(
    req: SocialExecuteRequest,
): Promise<Uint8Array> {
    const chain = loadSocialChainConfig();
    const ctx = {
        Transaction,
        chain,
        memoryAccountId: req.memoryAccountId,
    };

    let tx: Transaction;
    switch (req.action) {
        case "create_post":
            tx = buildCreatePostTx(ctx, req.params as any);
            break;
        case "create_comment":
            tx = buildCreateCommentTx(ctx, req.params as any);
            break;
        case "react_to_post":
            tx = buildReactToPostTx(ctx, req.params as any);
            break;
        case "react_to_comment":
            tx = buildReactToCommentTx(ctx, req.params as any);
            break;
        case "create_repost":
            tx = buildCreateRepostTx(ctx, req.params as any);
            break;
        case "delete_post":
            tx = buildDeletePostTx(chain, String(req.params.postId), Transaction);
            break;
        case "delete_comment":
            tx = buildDeleteCommentTx(
                chain,
                String(req.params.postId),
                String(req.params.commentId),
                Transaction,
            );
            break;
        default:
            throw new Error(`Unknown social action: ${req.action}`);
    }
    tx.setGasBudget(req.gasBudget ?? 50_000_000);
    return tx.build({ client: mysoClient as any, onlyTransactionKind: true });
}
