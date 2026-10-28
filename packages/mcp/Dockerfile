# Hosted MCP HTTP server.
# Build context is the directory that contains myso-memory and myso-messaging-stack:
#   docker build -f myso-memory/packages/mcp/Dockerfile .
# Railway uploads a context laid out the same way. The memory API service is not replaced.

FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app

COPY myso-memory/package.json myso-memory/pnpm-workspace.yaml myso-memory/pnpm-lock.yaml ./
COPY myso-memory/packages/sdk/package.json ./packages/sdk/package.json
COPY myso-memory/packages/sub-agents/package.json ./packages/sub-agents/package.json
COPY myso-memory/packages/mcp/package.json ./packages/mcp/package.json
COPY myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/package.json /myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/package.json
COPY myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/dist /myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/dist

RUN pnpm install --frozen-lockfile --filter @socialproof/memory-mcp...

COPY myso-memory/packages/sdk ./packages/sdk
COPY myso-memory/packages/sub-agents ./packages/sub-agents
COPY myso-memory/packages/mcp ./packages/mcp

RUN pnpm --filter @socialproof/memory build \
 && pnpm --filter @socialproof/sub-agents build \
 && pnpm --filter @socialproof/memory-mcp build

ENV PORT=8080
EXPOSE 8080
CMD ["node", "packages/mcp/dist/bin/memory-mcp-http.js"]
