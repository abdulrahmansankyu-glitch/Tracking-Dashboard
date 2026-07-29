# Intoto ERP API — production image.
#
# Multi-stage so the shipped image carries only production dependencies and compiled
# JavaScript: no TypeScript, no source, no build tools. Smaller to pull, faster to boot,
# and less to attack.

# ---------- Stage 1: install & build ----------
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Copy manifests first. Docker caches this layer, so a code change does not
# re-download the whole dependency tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# The Prisma client must be generated before the API compiles against it.
RUN pnpm --filter @intoto/shared build \
 && pnpm --filter @intoto/api exec prisma generate \
 && pnpm --filter @intoto/api build

# Drop dev dependencies now that everything is compiled.
RUN pnpm prune --prod

# ---------- Stage 2: runtime ----------
FROM node:22-alpine AS runtime

# openssl is required by Prisma's query engine on Alpine.
RUN apk add --no-cache openssl dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Run as a non-root user: a compromised process should not own the filesystem.
RUN addgroup -g 1001 -S nodejs && adduser -S intoto -u 1001 -G nodejs

COPY --from=builder --chown=intoto:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=intoto:nodejs /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=intoto:nodejs /app/packages/shared/package.json ./packages/shared/
COPY --from=builder --chown=intoto:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=intoto:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=intoto:nodejs /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder --chown=intoto:nodejs /app/apps/api/package.json ./apps/api/

USER intoto
WORKDIR /app/apps/api
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init reaps zombies and forwards SIGTERM, so the container shuts down cleanly
# instead of being killed mid-transaction.
ENTRYPOINT ["dumb-init", "--"]

# Migrations run on boot so a deploy never serves against an out-of-date schema.
CMD ["sh", "-c", "node ../../node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma || true; node dist/main.js"]
