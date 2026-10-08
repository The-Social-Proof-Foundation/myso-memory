# ============================================================
# Automation memory bridge — Dockerfile
#
# BUILD CONTEXT IS THE myso-memory REPO ROOT, not services/automation-sidecar.
# `@socialproof/memory` is a workspace dependency, and `packages/sdk/dist` is
# gitignored, so the image installs the workspace and builds the SDK itself.
#
#   docker build -f services/automation-sidecar/Dockerfile -t myso-automation-bridge .
#
# On Railway, set the service Root Directory to the repo root and point
# RAILWAY_DOCKERFILE_PATH at this file. Railway no longer reads config-as-code
# for new services, so there is deliberately no railway.json beside it.
# ============================================================

FROM node:22-bookworm-slim AS builder

# corepack reads `packageManager` from the root package.json (pnpm@9.12.3), so the
# image installs with the same package manager version as every developer machine.
RUN corepack enable
WORKDIR /app

# Whole-repo copy rather than per-package manifests: the layer cache is less
# granular, but a monorepo install is far more reliable when pnpm can see the
# complete workspace. .dockerignore keeps node_modules, dist, and .env out.
COPY . .

RUN corepack pnpm install --frozen-lockfile

# Apps import the SDK's compiled output, and it is gitignored, so this is not
# optional — skipping it produces a runtime "cannot find module" instead of a
# build failure, which is exactly the kind of break that only shows up in prod.
RUN corepack pnpm build:sdk

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
COPY --from=builder /app/services/automation-sidecar /app/services/automation-sidecar

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
