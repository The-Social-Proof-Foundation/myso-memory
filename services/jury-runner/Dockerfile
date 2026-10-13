# ============================================================
# Juror runner — Dockerfile
#
# BUILD CONTEXT IS THE myso-memory REPO ROOT, not services/jury-runner.
#
#   docker build -f services/jury-runner/Dockerfile -t myso-jury-runner .
#
# The runner needs the memory SDK only when it bills a juror to AI credit (INFERENCE_PROVIDER=gateway),
# but the SDK is a workspace dependency, so the image carries it either way, laid out as pnpm links it.
# On Railway, set the service Root Directory to the repo root and
# point RAILWAY_DOCKERFILE_PATH at this file. It needs a public HTTPS domain on port 443, because
# the automation engine calls it, and a volume mounted where STORE_PATH points.
# ============================================================

FROM node:22-bookworm-slim AS builder

RUN corepack enable
WORKDIR /app
COPY . .

RUN corepack pnpm install --frozen-lockfile
# The SDK is imported from its compiled output, which is gitignored.
RUN corepack pnpm build:sdk
RUN corepack pnpm --filter @socialproof/jury-runner build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# pnpm's links are relative and reach into /app/node_modules/.pnpm, so the layout is preserved.
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages/sdk /app/packages/sdk
COPY --from=builder /app/services/jury-runner /app/services/jury-runner

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8012
# Judgments and the engine's delivery answers live here; mount a volume at /data.
ENV STORE_PATH=/data/judgments.json

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8012

CMD ["node", "services/jury-runner/dist/main.js"]
