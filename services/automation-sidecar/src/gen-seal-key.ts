/**
 * Generate a delegate seal keypair.
 *
 *   pnpm gen:seal-key [key-id]
 *
 * Prints two lines:
 *   AUTOMATION_SEAL_PRIVATE_KEYS=<id>:<key>   → the bridge's Railway secret. Secret.
 *   VITE_AUTOMATION_SEAL_KEY=<id>:<key>       → the chat-app build variable. Public.
 *
 * The private line is the only secret in the delegate system: it is the one
 * thing that can open the sealed keys in the database. Put it in the bridge
 * service's variables and nowhere else. Run this on your own machine, not in a
 * CI log.
 */

import { generateSealKeyPair } from "./seal.js";

const id = process.argv[2] ?? `k${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}`;
if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    console.error("key id must be 1-32 characters of letters, digits, '_' or '-'");
    process.exit(1);
}

const { privateKey, publicKey } = generateSealKeyPair();
console.log(`AUTOMATION_SEAL_PRIVATE_KEYS=${id}:${privateKey.toString("base64url")}`);
console.log(`VITE_AUTOMATION_SEAL_KEY=${id}:${publicKey.toString("base64url")}`);
