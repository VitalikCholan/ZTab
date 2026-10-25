# Build from the repo root:
#   docker build -f pwa/Dockerfile --build-arg VITE_API_URL=/api --build-arg VITE_NETWORK=test -t ztab-pwa .
# The image only carries the built bundle; on start it copies it into the mounted /srv/pwa and exits.
FROM node:24-alpine AS build
RUN npm install -g pnpm@11.9.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY crypto/package.json crypto/package.json
COPY pwa/package.json pwa/package.json
RUN pnpm install --frozen-lockfile --filter @ztab/pwa...
# crypto: TS sources plus the committed wasm in pkg/ (not rebuilt here).
COPY crypto/src crypto/src
COPY crypto/pkg crypto/pkg
COPY pwa pwa
ARG VITE_API_URL
ARG VITE_NETWORK
ARG VITE_EXPLORER_TX_URL
ENV VITE_API_URL=$VITE_API_URL VITE_NETWORK=$VITE_NETWORK VITE_EXPLORER_TX_URL=$VITE_EXPLORER_TX_URL
RUN pnpm --filter @ztab/pwa build

FROM alpine:3.20 AS runtime
COPY --from=build /repo/pwa/dist /dist
COPY pwa/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
