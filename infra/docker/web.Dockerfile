# Intoto ERP web — production image. Only needed if you self-host the frontend;
# Netlify and Vercel build from source and do not use this file.
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN pnpm --filter @intoto/shared build && pnpm --filter @intoto/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S intoto -u 1001 -G nodejs
COPY --from=builder --chown=intoto:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=intoto:nodejs /app/packages/shared ./packages/shared
COPY --from=builder --chown=intoto:nodejs /app/apps/web/.next ./apps/web/.next
COPY --from=builder --chown=intoto:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=intoto:nodejs /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=builder --chown=intoto:nodejs /app/apps/web/package.json ./apps/web/
COPY --from=builder --chown=intoto:nodejs /app/apps/web/next.config.mjs ./apps/web/
USER intoto
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
