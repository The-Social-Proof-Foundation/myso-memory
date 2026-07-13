import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliMain } from "./cli.js";

export { runCli, runCliMain } from "./cli.js";
export {
    DEFAULT_CREDENTIALS_PATH,
    loadCredentials,
    parseCredentials,
    type McpCredentials,
} from "./credentials.js";
export {
    McpRuntimeError,
    formatStartupError,
    redactSensitiveText,
    toStructuredMcpError,
    type McpErrorCode,
    type StructuredMcpError,
} from "./errors.js";
export { createMemoryMcpServer } from "./server.js";
export { createHostedMcpHttpServer, type HostedMcpOptions } from "./hosted.js";
export {
    authenticateHostedRequest,
    OAuthIntrospectionVerifier,
    type HostedMcpPrincipal,
    type OAuthIntrospectionVerifierOptions,
} from "./oauth.js";
export {
    SponsoredSocialGateway,
    type SocialGateway,
    type SponsoredSocialGatewayOptions,
} from "./social-gateway.js";
export {
    InjectedAgentSigner,
    KmsSessionAgentSigner,
    HttpKmsSessionAuthorizer,
    RemoteKmsSigningProvider,
    LocalEd25519Signer,
    createCliSigner,
    type AgentSigner,
    type CliSignerReference,
    type DevelopmentFileSignerReference,
    type InjectedSignerCallbacks,
    type KeychainSignerReference,
    type KmsSessionAuthorizer,
    type KmsSessionPolicy,
    type KmsSigningOperation,
    type KmsSigningProvider,
    type RemoteKmsClientOptions,
    type LocalSecretAgentSigner,
} from "./signers.js";
export {
    LocalKeychainAgentProvisioner,
    type AgentSignerProvisioner,
    type ProvisionedAgentSigner,
} from "./provisioning.js";
export {
    createToolCatalog,
    executeTool,
    type MemoryClient,
    type ToolDependencies,
    type ToolEnvelope,
    TOOL_OAUTH_SCOPES,
} from "./tools.js";
export {
    MCP_PACKAGE_NAME,
    MCP_PACKAGE_VERSION,
    MCP_SERVER_NAME,
} from "./version.js";

function isMainModule(): boolean {
    const entrypoint = process.argv[1];
    return Boolean(entrypoint) && path.resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isMainModule()) runCliMain();
