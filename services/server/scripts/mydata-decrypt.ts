/**
 * MyData Decrypt Sidecar Script
 *
 * Decrypts MyData-encrypted data using admin wallet (TEE server).
 * Called by the Rust server as a subprocess.
 *
 * Flow:
 * 1. Parse EncryptedObject to extract the key ID
 * 2. Create SessionKey signed by admin wallet
 * 3. Build approve_key_policy PTB with the real ID
 * 4. Fetch keys from key servers (policy check happens here)
 * 5. Decrypt locally using fetched keys
 *
 * Usage:
 *   npx tsx mydata-decrypt.ts \
 *     --data <base64-encrypted> \
 *     --private-key <mysoprivkey1...> \
 *     --package-id <0x-package-id> \
 *     --account-id <0x-memory-account-object-id>
 *
 * Output (JSON to stdout):
 *   { "decryptedData": "<base64>" }
 *
 * Errors are written to stderr with non-zero exit code.
 */

import { MySoJsonRpcClient, getJsonRpcFullnodeUrl } from "@socialproof/myso/jsonRpc";
import { Ed25519Keypair } from "@socialproof/myso/keypairs/ed25519";
import { decodeMySoPrivateKey } from "@socialproof/myso/cryptography";
import { Transaction } from "@socialproof/myso/transactions";
import { MyDataClient, SessionKey, EncryptedObject } from "@socialproof/mydata";

// Network config from env vars
const MYSO_NETWORK = (process.env.MYSO_NETWORK || "mainnet") as "mainnet" | "testnet";
const MYDATA_KEY_SERVERS = [
    ...new Set(
        (process.env.MYDATA_KEY_SERVERS || "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
    ),
];

// ============================================================
// Parse CLI arguments
// ============================================================

function parseArgs(): {
    data: Uint8Array;
    privateKey: string;
    packageId: string;
    accountId: string;
} {
    const args = process.argv.slice(2);
    let data: string | undefined;
    let privateKey: string | undefined;
    let packageId: string | undefined;
    let accountId: string | undefined;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--data":
                data = args[++i];
                break;
            case "--private-key":
                privateKey = args[++i];
                break;
            case "--package-id":
                packageId = args[++i];
                break;
            case "--account-id":
                accountId = args[++i];
                break;
            case "--registry-id":
                console.error(
                    "error: --registry-id was removed; use --account-id <0x-memory-account-object-id>"
                );
                process.exit(1);
                break;
            case "--help":
                console.log(
                    "usage: mydata-decrypt.ts --data <base64> --private-key <mysoprivkey1...> --package-id <0x...> --account-id <0x-memory-account-object-id>"
                );
                process.exit(0);
        }
    }

    if (!data || !privateKey || !packageId || !accountId) {
        console.error(
            "error: required args: --data <base64> --private-key <mysoprivkey1...> --package-id <0x...> --account-id <0x-memory-account-object-id>"
        );
        process.exit(1);
    }

    return {
        data: Buffer.from(data, "base64"),
        privateKey,
        packageId,
        accountId,
    };
}

// ============================================================
// Main
// ============================================================

async function main() {
    const { data, privateKey, packageId, accountId } = parseArgs();

    const mysoClient = new MySoJsonRpcClient({
        url: getJsonRpcFullnodeUrl(MYSO_NETWORK),
        network: MYSO_NETWORK,
    });

    // Decode admin wallet (TEE server wallet = deployer)
    const { secretKey } = decodeMySoPrivateKey(privateKey);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);
    const adminAddress = keypair.getPublicKey().toMySoAddress();

    // Initialize MYDATA client
    const mydataClient = new MyDataClient({
        mysoClient: mysoClient as any,
        serverConfigs: MYDATA_KEY_SERVERS.map((id) => ({
            objectId: id,
            weight: 1,
        })),
        verifyKeyServers: true,
    });

    // Step 1: Parse the encrypted object to get the real key ID
    const encryptedData = new Uint8Array(data);
    const parsed = EncryptedObject.parse(encryptedData);
    const fullId = parsed.id; // hex string of the owner's address

    // Convert hex ID to byte array for the PTB
    const idBytes = Array.from(
        Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
    );

    // Step 2: Create session key (auto-signs with signer)
    // LOW-13: Reduced from 30 to 5 minutes to match sidecar policy.
    const sessionKey = await SessionKey.create({
        address: adminAddress,
        packageId,
        ttlMin: 5,
        signer: keypair,
        mysoClient: mysoClient as any,
    });

    // Step 3: Build approve_key_policy PTB with REAL ID
    // approve_key_policy(id: vector<u8>, account: &MemoryAccount, ctx: &TxContext)
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::memory::approve_key_policy`,
        arguments: [
            tx.pure("vector<u8>", idBytes), // real ID from encrypted object
            tx.object(accountId), // MemoryAccount shared object
        ],
    });
    const txBytes = await tx.build({ client: mysoClient as any, onlyTransactionKind: true });

    // Step 4: Fetch keys from key servers (policy check happens here)
    await mydataClient.fetchKeys({
        ids: [fullId],
        txBytes,
        sessionKey,
        threshold: 1,
    });

    // Step 5: Decrypt locally using fetched keys
    const decrypted = await mydataClient.decrypt({
        data: encryptedData,
        sessionKey,
        txBytes,
    });

    // Output as JSON to stdout
    const decryptedBase64 = Buffer.from(decrypted).toString("base64");
    console.log(JSON.stringify({ decryptedData: decryptedBase64 }));
}

main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`mydata-decrypt error: ${msg}`);
    if (err instanceof Error && err.stack) {
        console.error(err.stack);
    }
    process.exit(1);
});
