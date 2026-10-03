# ============================================================
# Automation service — Dockerfile
# Build context: services/automation (Railway Root Directory)
# ============================================================

# Tag: rust:1.85-bookworm  |  arch: linux/amd64  |  pinned: 2026-04-16
FROM rust:1.85-bookworm@sha256:bf7d87666c4da6eace19e06d21bc4859c6e2a5c97a21ac273b0e082112753cf0 AS builder

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
