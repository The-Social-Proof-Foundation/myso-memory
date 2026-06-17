import type {
    CreateCommentParams,
    CreatePostParams,
    CreateRepostParams,
    DeleteCommentParams,
    ReactToCommentParams,
    ReactToPostParams,
    SocialActionResult,
    SocialClientConfig,
} from "./types.js";
import { sha256hex, hexToBytes, bytesToHex, normalizeServerUrl } from "./signing.js";
import { MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION } from "@socialproof/memory";

let _ed: typeof import("@noble/ed25519") | null = null;
async function getEd() {
    if (!_ed) _ed = await import("@noble/ed25519");
    return _ed;
}

export class SocialClient {
    private privateKey: Uint8Array;
    private publicKey: Uint8Array | null = null;
    private serverUrl: string;
    private accountId: string;
    private platformId?: string;
    private ownerCoSignKey: Uint8Array | null;

    private constructor(config: SocialClientConfig) {
        this.privateKey =
            typeof config.key === "string" ? hexToBytes(config.key) : config.key;
        this.accountId = config.accountId;
        this.serverUrl = normalizeServerUrl(
            config.serverUrl ?? "https://memory.mysocial.network/",
        );
        this.platformId = config.platformId;
        this.ownerCoSignKey = config.ownerCoSignKey
            ? typeof config.ownerCoSignKey === "string"
                ? hexToBytes(config.ownerCoSignKey)
                : config.ownerCoSignKey
            : null;
    }

    static create(config: SocialClientConfig): SocialClient {
        return new SocialClient(config);
    }

    async createPost(params: CreatePostParams): Promise<SocialActionResult> {
        return this.signedRequest("POST", "/api/social/post", params);
    }

    async createComment(params: CreateCommentParams): Promise<SocialActionResult> {
        return this.signedRequest("POST", "/api/social/comment", params);
    }

    async reactToPost(params: ReactToPostParams): Promise<SocialActionResult> {
        return this.signedRequest("POST", "/api/social/react/post", params);
    }

    async reactToComment(params: ReactToCommentParams): Promise<SocialActionResult> {
        return this.signedRequest("POST", "/api/social/react/comment", params);
    }

    async createRepost(params: CreateRepostParams): Promise<SocialActionResult> {
        return this.signedRequest("POST", "/api/social/repost", params);
    }

    /**
     * Delete a post. Requires ownerCoSignKey — on-chain sender must be the human principal.
     */
    async deletePost(postId: string): Promise<SocialActionResult> {
        this.requireOwnerKey("deletePost");
        return this.signedRequest("DELETE", `/api/social/post/${postId}`, {}, {
            requireOwnerCoSign: true,
            includeOwnerDelegateKey: true,
        });
    }

    /**
     * Delete a comment. Requires ownerCoSignKey — on-chain sender must be the human principal.
     */
    async deleteComment(params: DeleteCommentParams): Promise<SocialActionResult> {
        this.requireOwnerKey("deleteComment");
        return this.signedRequest(
            "DELETE",
            `/api/social/comment/${params.commentId}`,
            { postId: params.postId },
            { requireOwnerCoSign: true, includeOwnerDelegateKey: true },
        );
    }

    private requireOwnerKey(method: string): void {
        if (!this.ownerCoSignKey) {
            throw new Error(
                `${method} requires ownerCoSignKey on SocialClient (human principal must co-sign and sign the chain tx)`,
            );
        }
    }

    private isSocialWrite(method: string, path: string): boolean {
        return path.startsWith("/api/social/");
    }

    private async getPublicKey(): Promise<Uint8Array> {
        if (!this.publicKey) {
            const ed = await getEd();
            this.publicKey = await ed.getPublicKeyAsync(this.privateKey);
        }
        return this.publicKey;
    }

    private async signedRequest<T>(
        method: string,
        path: string,
        body: object,
        options: {
            requireOwnerCoSign?: boolean;
            includeOwnerDelegateKey?: boolean;
        } = {},
    ): Promise<T> {
        const ed = await getEd();
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr =
            method === "GET" ? "" : JSON.stringify(body);
        const bodySha256 = await sha256hex(bodyStr);
        const nonce = crypto.randomUUID();
        const message = `${timestamp}.${method}.${path}.${bodySha256}.${nonce}.${this.accountId}`;
        const msgBytes = new TextEncoder().encode(message);
        const signature = await ed.signAsync(msgBytes, this.privateKey);
        const publicKey = await this.getPublicKey();

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-public-key": bytesToHex(publicKey),
            "x-signature": bytesToHex(signature),
            "x-timestamp": timestamp,
            "x-nonce": nonce,
            "x-account-id": this.accountId,
            "x-sdk-compatibility": MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION,
            "x-delegate-key": bytesToHex(this.privateKey),
        };
        if (this.platformId) {
            headers["x-platform-id"] = this.platformId;
        }

        const needsOwnerCoSign =
            options.requireOwnerCoSign ||
            (this.ownerCoSignKey && this.isSocialWrite(method, path));
        if (needsOwnerCoSign && this.ownerCoSignKey) {
            const ownerSig = await ed.signAsync(msgBytes, this.ownerCoSignKey);
            const ownerPk = await ed.getPublicKeyAsync(this.ownerCoSignKey);
            headers["x-owner-public-key"] = bytesToHex(ownerPk);
            headers["x-owner-signature"] = bytesToHex(ownerSig);
            if (options.includeOwnerDelegateKey) {
                headers["x-owner-delegate-key"] = bytesToHex(this.ownerCoSignKey);
            }
        }

        const url = `${this.serverUrl}${path}`;
        const res = await fetch(url, {
            method,
            headers,
            body: method === "GET" || bodyStr === "" ? undefined : bodyStr,
        });

        if (!res.ok) {
            const raw = await res.text();
            throw new Error(`Social API ${method} ${path} failed (${res.status}): ${raw}`);
        }
        return res.json() as Promise<T>;
    }
}
