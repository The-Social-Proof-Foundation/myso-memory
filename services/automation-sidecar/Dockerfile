# ============================================================
# Automation memory bridge — Dockerfile
#
# BUILD CONTEXT is the directory containing both `myso-memory` and
# `myso-messaging-stack`, because hosted MCP reuses the messaging SDK from that
# sibling checkout.
#
#   docker build -f myso-memory/services/automation-sidecar/Dockerfile -t myso-automation-bridge .
#
# The Railway build context must contain the parent directory's sibling repo
# layout. Point RAILWAY_DOCKERFILE_PATH at this file; Railway no longer reads
# config-as-code for new services, so there is deliberately no railway.json.
# ============================================================

FROM node:22-bookworm-slim AS builder

# corepack reads `packageManager` from the Memory workspace root.
RUN corepack enable
WORKDIR /app

# Copy only build inputs: do not bake local .env files, key material, or unrelated
# workspace files into the image. The messaging SDK is built in its own repository.
COPY myso-memory/package.json myso-memory/pnpm-workspace.yaml myso-memory/pnpm-lock.yaml ./
COPY myso-memory/packages/sdk/package.json ./packages/sdk/package.json
COPY myso-memory/packages/sub-agents/package.json ./packages/sub-agents/package.json
COPY myso-memory/packages/mcp/package.json ./packages/mcp/package.json
COPY myso-memory/services/automation-sidecar/package.json ./services/automation-sidecar/package.json
COPY myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/package.json /myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/package.json
COPY myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/dist /myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/dist

RUN corepack pnpm install --frozen-lockfile --filter @socialproof/automation-sidecar...

COPY myso-memory/packages/sdk ./packages/sdk
COPY myso-memory/packages/sub-agents ./packages/sub-agents
COPY myso-memory/packages/mcp ./packages/mcp
COPY myso-memory/services/automation-sidecar ./services/automation-sidecar

# Apps import the SDK's compiled output, and it is gitignored, so this is not
# optional — skipping it produces a runtime "cannot find module" instead of a
# build failure, which is exactly the kind of break that only shows up in prod.
RUN corepack pnpm build:sdk

# Chain actions go through the registered-action client, which is also gitignored output.
RUN corepack pnpm --filter @socialproof/sub-agents build

# The run-scoped room-history bridge reuses the hosted MCP's strict room
# authorization/decryption adapter rather than implementing a second reader.
RUN corepack pnpm --filter @socialproof/memory-mcp build

# Compiled output, so the runtime image ships no TypeScript and no tsx.
RUN corepack pnpm --filter @socialproof/automation-sidecar build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only what the bridge needs to resolve at runtime. pnpm's symlinks are relative
# and reach into /app/node_modules/.pnpm, so the directory layout has to be
# preserved exactly — hence copying at the same paths rather than flattening.
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages/sdk /app/packages/sdk
COPY --from=builder /app/packages/sub-agents /app/packages/sub-agents
COPY --from=builder /app/packages/mcp /app/packages/mcp
COPY --from=builder /app/services/automation-sidecar /app/services/automation-sidecar
COPY --from=builder /myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/package.json /myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/package.json
COPY --from=builder /myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/dist /myso-messaging-stack/ts-sdks/packages/myso-messaging-stack/dist

ENV NODE_ENV=production
# Bind all interfaces. The code default is loopback, which is right on a laptop
# and wrong in a container: Railway does not set HOST, so a loopback-bound server
# fails its own healthcheck while logging a healthy startup line.
ENV HOST=0.0.0.0
ENV PORT=8011

# The bridge opens encrypted delegate keys in memory at request time and writes
# nothing to disk, so it does not need to own any files. NODE_ENV=production
# also makes it refuse any plaintext agent-key file or variable.
USER node
EXPOSE 8011

CMD ["node", "services/automation-sidecar/dist/server.js"]
