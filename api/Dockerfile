# Build from the repo root: docker build -f api/Dockerfile -t ztab-api .
FROM node:24-alpine AS build
RUN npm install -g pnpm@11.9.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY crypto/package.json crypto/package.json
COPY api/package.json api/package.json
RUN pnpm install --frozen-lockfile --filter @ztab/api...
COPY api api
RUN pnpm --filter @ztab/api build
# Production dependencies only (the Prisma CLI is one: `migrate deploy` runs at start).
RUN pnpm --filter @ztab/api deploy --legacy --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/api/dist ./dist
COPY --from=build /repo/api/prisma ./prisma
COPY --from=build /repo/api/prisma.config.ts ./prisma.config.ts
COPY api/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
