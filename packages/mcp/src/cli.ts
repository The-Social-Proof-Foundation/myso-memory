import { Memory } from "@socialproof/memory";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCredentials } from "./credentials.js";
import { formatStartupError } from "./errors.js";
import { createMemoryMcpServer } from "./server.js";
import { SponsoredSocialGateway } from "./social-gateway.js";
import { createCliSigner } from "./signers.js";
import { LocalKeychainAgentProvisioner } from "./provisioning.js";

export async function runCli(): Promise<void> {
    const credentials = loadCredentials();
    const signer = createCliSigner(credentials.signer);
    const memory = await signer.withLocalSecret((secret) =>
        Memory.create({
            key: secret.slice(),
            accountId: credentials.accountId,
            serverUrl: credentials.serverUrl,
            platformId: credentials.platformId,
        }),
    );
    const social = credentials.socialEnabled && credentials.social
        ? new SponsoredSocialGateway({
              signer,
              accountId: credentials.accountId,
              serverUrl: credentials.socialGatewayUrl,
              platformId: credentials.platformId,
              network: credentials.social.network,
              rpcUrl: credentials.social.rpcUrl,
              chain: credentials.social.chain,
          })
        : undefined;
    const server = createMemoryMcpServer({
        memory,
        social,
        agentProvisioner: process.platform === "darwin"
            ? new LocalKeychainAgentProvisioner()
            : undefined,
    });
    const transport = new StdioServerTransport();
    let closing = false;

    const shutdown = async (): Promise<void> => {
        if (closing) return;
        closing = true;
        memory.destroy();
        signer.destroy();
        await server.close();
    };

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());

    try {
        await server.connect(transport);
    } catch (error) {
        await shutdown();
        throw error;
    }
}

export function runCliMain(): void {
    runCli().catch((error) => {
        process.stderr.write(`memory-mcp: ${formatStartupError(error)}\n`);
        process.exitCode = 1;
    });
}
