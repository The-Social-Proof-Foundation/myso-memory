/**
 * File Storage Upload Relay Script (multi-step flow)
 *
 * Uses the writeBlobFlow stateful API (encode → register → upload → certify)
 * instead of writeBlob (one-shot). This avoids signer mismatch errors
 * when existing Blob objects belong to a different wallet.
 *
 * Called by the Rust server as a subprocess.
 *
 * Usage:
 *   npx tsx file-storage-upload.ts \
 *     --data <base64-encoded-blob> \
 *     --private-key <mysoprivkey1...> \
 *     --owner <0x-myso-address> \
 *     [--epochs <number>]
 *
 * Output (JSON to stdout):
 *   { "blobId": "...", "objectId": "..." }
 *
 * Errors are written to stderr with non-zero exit code.
 */

import { FileStorageClient } from "@socialproof/file-storage";
import { MySoJsonRpcClient, getJsonRpcFullnodeUrl } from "@socialproof/myso/jsonRpc";
import { Ed25519Keypair } from "@socialproof/myso/keypairs/ed25519";
import { decodeMySoPrivateKey } from "@socialproof/myso/cryptography";

// ============================================================
// Parse CLI arguments
// ============================================================

function parseArgs(): {
    data: Buffer;
    privateKey: string;
    owner: string;
    epochs: number;
} {
    const args = process.argv.slice(2);
    let data: string | undefined;
    let privateKey: string | undefined;
    let owner: string | undefined;
    let epochs = 50;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--data":
                data = args[++i];
                break;
            case "--private-key":
                privateKey = args[++i];
                break;
            case "--owner":
                owner = args[++i];
                break;
            case "--epochs":
                epochs = parseInt(args[++i], 10);
                break;
            case "--help":
                console.log(
                    "usage: file-storage-upload.ts --data <base64> --private-key <mysoprivkey1...> --owner <0x...> [--epochs N]"
                );
                process.exit(0);
        }
    }

    if (!data || !privateKey || !owner) {
        console.error(
            "error: required args: --data <base64> --private-key <mysoprivkey1...> --owner <0x...>"
        );
        process.exit(1);
    }

    return {
        data: Buffer.from(data, "base64"),
        privateKey,
        owner,
        epochs,
    };
}

// ============================================================
// Main
// ============================================================

async function main() {
    const { data, privateKey, owner, epochs } = parseArgs();

    // Decode MySo private key (bech32 → keypair)
    const { secretKey } = decodeMySoPrivateKey(privateKey);
    const signer = Ed25519Keypair.fromSecretKey(secretKey);

    // Network config from env vars
    const MYSO_NETWORK = (process.env.MYSO_NETWORK || "mainnet") as "mainnet" | "testnet";
    const FILE_STORAGE_UPLOAD_RELAY_URL = process.env.FILE_STORAGE_UPLOAD_RELAY_URL || (
        MYSO_NETWORK === "testnet"
            ? "https://upload-relay.testnet.mysocial.network"
            : "https://upload-relay.mainnet.mysocial.network"
    );

    // Create MySo JSON-RPC client
    const mysoClient = new MySoJsonRpcClient({
        url: getJsonRpcFullnodeUrl(MYSO_NETWORK),
        network: MYSO_NETWORK,
    });

    // Create FileStorageClient with upload relay
    const FileStorageClient = new FileStorageClient({
        network: MYSO_NETWORK,
        mysoClient: mysoClient as any,
        uploadRelay: {
            host: FILE_STORAGE_UPLOAD_RELAY_URL,
            sendTip: { max: 10_000_000 },
        },
    });

    // writeBlobFlow is a stateful object — each step stores results internally
    const flow = FileStorageClient.writeBlobFlow({
        blob: new Uint8Array(data),
    });

    // Step 1: Encode (Red Stuff encoding, stores internally)
    await flow.encode();

    // Step 2: Register blob on MySo → returns a Transaction
    // Use signer address as owner so sender = signer (avoids mismatch).
    // Memory only needs the blobId to download/decrypt — blob ownership
    // on File Storage doesn't affect the MYDATA encryption/decryption flow.
    const signerAddress = signer.toMySoAddress();
    const registerTx = flow.register({
        epochs,
        owner: signerAddress,
        deletable: true,
    });

    // Sign and execute the register transaction
    const registerResult = await mysoClient.signAndExecuteTransaction({
        signer,
        transaction: registerTx,
    });

    // Step 3: Upload encoded data to relay
    await flow.upload({ digest: registerResult.digest });

    // Step 4: Certify blob on MySo → returns a Transaction
    const certifyTx = flow.certify();

    // Sign and execute the certify transaction
    await mysoClient.signAndExecuteTransaction({
        signer,
        transaction: certifyTx,
    });

    // Get blob info from the flow
    const blob = await flow.getBlob();

    console.log(JSON.stringify({
        blobId: blob.blobId,
        objectId: (blob.blobObject as any)?.id ?? null,
    }));
}

main().catch((err) => {
    console.error(`file-storage-upload error: ${err.message || err}`);
    process.exit(1);
});
