# Unified AI Ads Agent — web app (Next.js 16, App Router)
#
# Review P2. Three problems with the previous version:
#   1. the runtime stage did `COPY --from=build /app ./` — the ENTIRE build tree
#      (source, dev dependencies, tests) shipped to production;
#   2. it ran as root;
#   3. migrations ran via `npx drizzle-kit migrate`, a DEV dependency that is
#      absent from a production install — and whose CLI hides errors behind a
#      TUI spinner in CI (the reason scripts/migrate.mjs exists in this repo).
#
# Now: standalone output, a non-root user, and migrations through the same
# runner the project already trusts.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# google-ads is an OPTIONAL dependency for production mode (gRPC client, heavy).
# For production deployment install it in the build stage:
# RUN npm i google-ads --no-audit --no-fund
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /app
# HOSTNAME=0.0.0.0 is REQUIRED: the standalone server.js listens on localhost by
# default, which inside a container means nothing outside it can connect.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0

# Run as an unprivileged user (the node image ships uid/gid 1000 "node").
# A container escape or RCE then lands on a user that cannot write the app.
USER node

# Standalone server + static assets only — no source, no dev dependencies.
# Note: standalone does NOT include .next/static or public; they must be copied
# separately or every asset 404s.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Migration runner and its SQL. scripts/migrate.mjs uses the drizzle-orm
# migrator (NOT the drizzle-kit CLI, which is a dev dependency and hides errors
# behind a TUI spinner in CI — see the header of that script).
COPY --from=build --chown=node:node /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build --chown=node:node /app/drizzle ./drizzle

# Standalone tracing bundles what the APP imports. src/lib/tenant/pool.ts already
# imports `pg` and `drizzle-orm/node-postgres`, so both packages (and pg's five
# transitive deps) are traced in. The one thing the app never imports is the
# migrator submodule used by scripts/migrate.mjs, so overlay the full
# drizzle-orm package — it has ZERO dependencies, making this a safe, complete
# overlay rather than a hand-picked subset.
COPY --from=deps --chown=node:node /app/node_modules/drizzle-orm ./node_modules/drizzle-orm

EXPOSE 3000

# Оркестратор должен уметь отличить «процесс жив» от «приложение работает».
# /api/health отдаёт 503 при недоступной базе, поэтому проверка ловит и
# потерю соединения с Postgres, а не только упавший Node.
#
# node вместо curl/wget: образ на alpine, где их нет, а ставить пакет ради
# healthcheck значит расширять поверхность атаки. start-period покрывает
# прогон миграций при старте контейнера.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `server.js` is the standalone entrypoint (replaces `npm start`).
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
