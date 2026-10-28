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
 * For manual (client-side MYDATA + private R2 transport), import from "@socialproof/memory/manual".
 */

// Core client (server-mode: server handles MYDATA + private R2 + embedding)
export { Memory, AiCreditApprovalRequiredError } from "./memory.js";
export { parseMySoKnowledgeGraph, searchMyDataGraph, getMyDataGraphItem } from "./knowledge-graph.js";
export type { MySoKnowledgeGraph, MySoGraphNode, MySoGraphEdge, MySoGraphEdgeKind, MySoGraphEvidence, MySoGraphProvenance, MyDataGraphSearchRequest, MyDataGraphSearchResult, MyDataGraphItemRequest, MyDataGraphItemResult } from "./knowledge-graph.js";
export { canonicalGraphJson, createMySoGraphPublication, decodeMySoGraphPublicationTags, encodeMySoGraphPublicationTags, graphManifestHashHex, parseMySoGraphManifest, verifyMySoGraphPublication, verifyMySoGraphPublicationMetadata } from "./graph-manifest.js";
export type { GraphAuthorityVerifier, GraphOnchainQuoteTerms, GraphPublicationSigner, MySoGraphAuthorityProof, MySoGraphManifest, MySoGraphOfferTerms, MySoGraphPublication, MySoGraphPublicationDocument, MySoGraphSourceRight } from "./graph-manifest.js";

// Delegate key utilities (no @socialproof/myso dependency)
export { delegateKeyToMySoAddress, delegateKeyToPublicKey } from "./utils.js";

export {
    assertCompatibleRelayer,
    compatibilityErrorFromStatus,
    MemoryCompatibilityError,
    MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION,
} from "./compatibility.js";

export {
    MAX_ORGANIZATIONS_PER_USER,
    ORG_TYPE_COMPANY,
    ORG_TYPE_STARTUP,
    ORG_TYPE_INVESTMENT_FUND,
    ORG_TYPE_NONPROFIT,
    ORG_TYPE_RESEARCH,
    ORG_TYPE_GOVERNMENT,
    ORG_TYPE_MEDIA,
    ORG_TYPE_STEWARDSHIP,
    ORG_TYPE_BRAND,
    ORG_TYPE_COMMUNITY,
    ORG_TYPE_SPORTS,
    ORG_TYPE_EDUCATION,
    ORG_TYPE_HEALTHCARE,
    ORG_TYPE_OTHER,
    ORG_TYPE_COUNT,
    OrganizationType,
} from "./contract.js";

export type {
    MemoryConfig,
    MyDataContentRequest,
    MyDataContentPage,
    RememberAcceptedResponse,
    RememberJobResult,
    RememberJobPollOptions,
    RememberBulkAcceptedResponse,
    RememberBulkStatusItem,
    RememberResult,
    RecallResult,
    RecallMemory,
    RecallOptions,
    RememberOptions,
    MemoryVisibility,
    RecallScope,
    ScoringWeights,
    RelayerVersionMetadata,
    EmbedResult,
    AnalyzeResult,
    AnalyzedFact,
    GatewayInferenceResult,
    HealthResult,
    RestoreResult,
} from "./types.js";

export * from "./agent-key-envelope.js";
export * from "./agent-key-backup-client.js";
