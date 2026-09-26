# API image. Source stays split under server/api, server/db, and server/worker,
# but they share one package.json.
FROM node:22.12-bookworm-slim AS deps

RUN npm install -g pnpm@10

WORKDIR /app

# Frozen install checks every workspace importer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY server/package.json server/package.json
COPY electron/adamant/package.json electron/adamant/package.json
COPY electron/main/package.json electron/main/package.json
COPY electron/preload/package.json electron/preload/package.json
COPY electron/shared/package.json electron/shared/package.json

RUN pnpm install --frozen-lockfile --filter @adamant/server --prod --ignore-scripts

FROM node:22.12-bookworm-slim AS runner

ENV NODE_ENV=production
ENV PORT=8787

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/package.json server/package.json
COPY server/api server/api
COPY server/db server/db

WORKDIR /app/server

USER node

EXPOSE 8787

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--experimental-strip-types", "api/index.ts"]
