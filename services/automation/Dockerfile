# ============================================================
# Automation service — Dockerfile
# Build context: services/automation (Railway Root Directory)
# ============================================================

# Tag: rust:1.94.1-bookworm  |  manifest index (linux amd64 + arm64)  |  pinned: 2026-10-03
# home 0.5.12 requires rustc 1.88; icu_* 2.2.0 requires rustc 1.86.
# To refresh: docker buildx imagetools inspect rust:1.94.1-bookworm
FROM rust:1.94.1-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo "" > src/lib.rs \
    && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src

COPY src/ src/
COPY migrations/ migrations/
RUN touch src/lib.rs src/main.rs \
    && cargo build --release

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd -ms /bin/bash appuser
USER appuser
WORKDIR /app

COPY --from=builder --chown=appuser:appuser /app/target/release/myso-automation ./myso-automation
COPY --chown=appuser:appuser migrations/ ./migrations/

ENV PORT=8010
EXPOSE 8010

CMD ["./myso-automation"]
