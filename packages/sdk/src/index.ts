/**
 * @socialproof/memory
 *
 * Privacy-first AI memory SDK.
 * Ed25519 delegate key auth + server-side TEE processing.
 *
 * This is the default entry point — Memory client + types only.
 * Does NOT import account.js (which requires @socialproof/myso).
 *
 * For account management, import from "@socialproof/memory/account".
 * For manual (client-side MYDATA + File Storage), import from "@socialproof/memory/manual".
 */

// Core client (server-mode: server handles MYDATA + File Storage + embedding)
export { Memory } from "./memory.js";

// Delegate key utilities (no @socialproof/myso dependency)
export { delegateKeyToMySoAddress, delegateKeyToPublicKey } from "./utils.js";

export {
    assertCompatibleRelayer,
    compatibilityErrorFromStatus,
    MemoryCompatibilityError,
    MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION,
} from "./compatibility.js";

export type {
    MemoryConfig,
    RememberAcceptedResponse,
    RememberJobResult,
    RememberJobPollOptions,
    RememberBulkAcceptedResponse,
    RememberBulkStatusItem,
    RememberResult,
    RecallResult,
    RecallMemory,
    RecallOptions,
    ScoringWeights,
    RelayerVersionMetadata,
    EmbedResult,
    AnalyzeResult,
    AnalyzedFact,
    HealthResult,
    RestoreResult,
} from "./types.js";
