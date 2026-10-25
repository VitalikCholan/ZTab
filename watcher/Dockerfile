# syntax=docker/dockerfile:1
FROM rust:1.98-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --locked --recipe-path recipe.json
COPY . .
RUN cargo build --release --locked --bin ztab-watcher

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin watcher \
 && mkdir /data && chown watcher:watcher /data
COPY --from=builder /app/target/release/ztab-watcher /usr/local/bin/ztab-watcher
ENV ZTAB_DATA_DIR=/data ZTAB_LISTEN=0.0.0.0:8787
USER watcher
VOLUME /data
EXPOSE 8787
# /v1/health is the one public route, so no bearer token is needed here.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8787/v1/health || exit 1
ENTRYPOINT ["/usr/local/bin/ztab-watcher"]
