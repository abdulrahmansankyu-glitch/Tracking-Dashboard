# Intoto ERP API — production image.
#
# Deliberately simple. An earlier version pruned dev dependencies and hand-picked which
# directories to carry into the runtime stage; both saved image size and both broke the
# deployment — pnpm's node_modules is a web of symlinks into a content-addressed store,
# and copying pieces of it out of order leaves dangling links that only fail at runtime.
# A larger image that starts is worth more than a small one that does not.

FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Manifests first: Docker caches this layer, so editing source does not re-resolve the
# whole dependency tree. Every workspace manifest must be here — the lockfile has an
# importer for each, and `--frozen-lockfile` fails if one is missing.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY infra ./infra

# The Prisma client must be generated before the API compiles against it.
RUN pnpm --filter @intoto/shared build \
 && pnpm --filter @intoto/api exec prisma generate \
 && pnpm --filter @intoto/api build

# ---------- Runtime ----------
FROM node:22-alpine AS runtime

# openssl is required by Prisma's query engine on Alpine. dumb-init reaps zombies and
# forwards SIGTERM, so the container stops cleanly instead of being killed mid-transaction.
RUN apk add --no-cache openssl dumb-init

ENV NODE_ENV=production
WORKDIR /app

# A compromised process should not own the filesystem.
RUN addgroup -g 1001 -S nodejs && adduser -S intoto -u 1001 -G nodejs

# Copied whole, so pnpm's symlinks keep pointing at targets that exist.
COPY --from=builder --chown=intoto:nodejs /app /app

USER intoto
WORKDIR /app/apps/api
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD sh -c 'node -e "fetch(\"http://127.0.0.1:\"+(process.env.PORT||4000)+\"/api/v1/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' 

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "/app/infra/docker/api-entrypoint.sh"]
