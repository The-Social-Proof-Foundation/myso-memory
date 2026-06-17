/**
 * @socialproof/memory/manual
 *
 * Manual (client-side) mode entry point.
 * Requires: @socialproof/mydata, @socialproof/file-storage, @socialproof/myso
 *
 * Usage:
 *   import { MemoryManual } from "@socialproof/memory/manual";
 */

export { MemoryManual } from "./manual.js";

export type {
    MemoryManualConfig,
    WalletSigner,
    RememberManualOptions,
    RememberManualResult,
    RecallManualOptions,
    RecallManualResult,
    RecallManualHit,
    RecallManualMemory,
} from "./types.js";
