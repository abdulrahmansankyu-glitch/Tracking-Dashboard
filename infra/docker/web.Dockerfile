# Intoto ERP web — production image.
#
# Kept in step with api.Dockerfile: the whole build tree is carried into the runtime
# stage rather than hand-picked directories, because pnpm's node_modules is a web of
# symlinks into a content-addressed store, and copying it piecemeal leaves dangling
# links that fail only once the container is running.

FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Every workspace manifest is required — the lockfile has an importer for each, and
# `--frozen-lockfile` fails if one is absent.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

RUN pnpm --filter @intoto/shared build && pnpm --filter @intoto/web build

# ---------- Runtime ----------
FROM node:22-alpine AS runtime

RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S intoto -u 1001 -G nodejs

COPY --from=builder --chown=intoto:nodejs /app /app

USER intoto
WORKDIR /app/apps/web
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
# Bound to 0.0.0.0 so the platform's router can reach it — the default localhost bind
# makes the container look dead from outside. PORT is supplied by the host.
CMD ["sh", "-c", "./node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]
