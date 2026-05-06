/**
 * MYDATA Encrypt Sidecar Script
 *
 * Encrypts data using MYDATA threshold encryption.
 * Called by the Rust server as a subprocess.
 *
 * Uses @socialproof/mydata MyDataClient.encrypt() with the user's address as key ID.
 *
 * Usage:
 *   npx tsx mydata-encrypt.ts \
 *     --data <base64-encoded-plaintext> \
 *     --owner <0x-myso-address> \
 *     --package-id <0x-package-id>
 *
 * Output (JSON to stdout):
 *   { "encryptedData": "<base64>" }
 *
 * Errors are written to stderr with non-zero exit code.
 */

import { MySoJsonRpcClient, getJsonRpcFullnodeUrl } from "@socialproof/myso/jsonRpc";
import { MyDataClient } from "@socialproof/mydata";

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
    owner: string;
    packageId: string;
} {
    const args = process.argv.slice(2);
    let data: string | undefined;
    let owner: string | undefined;
    let packageId: string | undefined;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--data":
                data = args[++i];
                break;
            case "--owner":
                owner = args[++i];
                break;
            case "--package-id":
                packageId = args[++i];
                break;
            case "--help":
                console.log(
                    "usage: mydata-encrypt.ts --data <base64> --owner <0x...> --package-id <0x...>"
                );
                process.exit(0);
        }
    }

    if (!data || !owner || !packageId) {
        console.error(
            "error: required args: --data <base64> --owner <0x...> --package-id <0x...>"
        );
        process.exit(1);
    }

    return {
        data: Buffer.from(data, "base64"),
        owner,
        packageId,
    };
}

// ============================================================
// Main
// ============================================================

async function main() {
    const { data, owner, packageId } = parseArgs();

    const mysoClient = new MySoJsonRpcClient({
        url: getJsonRpcFullnodeUrl(MYSO_NETWORK),
        network: MYSO_NETWORK,
    });

    const mydataClient = new MyDataClient({
        mysoClient: mysoClient as any,
        serverConfigs: MYDATA_KEY_SERVERS.map((id) => ({
            objectId: id,
            weight: 1,
        })),
        verifyKeyServers: true,
    });

    // Encrypt with threshold 1 (need 1 of N key servers to decrypt)
    // The MYDATA SDK uses packageId + id to derive the encryption key
    const result = await mydataClient.encrypt({
        threshold: 1,
        packageId,
        id: owner,
        data: new Uint8Array(data),
    });

    // Output as JSON to stdout
    const encryptedBase64 = Buffer.from(result.encryptedObject).toString("base64");
    console.log(JSON.stringify({ encryptedData: encryptedBase64 }));
}

main().catch((err) => {
    console.error(`mydata-encrypt error: ${err.message || err}`);
    process.exit(1);
});
