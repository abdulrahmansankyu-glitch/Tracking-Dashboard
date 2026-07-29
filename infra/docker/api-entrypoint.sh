#!/bin/sh
# Boot sequence for the Intoto ERP API.
#
# Runs before the server accepts traffic, so the process never serves against a schema it
# does not match, and a fresh deployment is usable on arrival rather than presenting a
# login screen with no accounts to sign in with.
set -e

cd /app/apps/api

# Resolved through the package's own bin directory. pnpm does not hoist to a single
# top-level node_modules, so an absolute path into /app/node_modules is not reliable.
PRISMA="./node_modules/.bin/prisma"
TSX="./node_modules/.bin/tsx"

echo "→ Applying database migrations"
$PRISMA migrate deploy --schema prisma/schema.prisma

# Seed only into an empty database. The seed is idempotent, but checking first keeps a
# restart from re-upserting hundreds of rows, and means a future non-idempotent addition
# can never disturb live business data.
if [ "$RUN_SEED_ON_BOOT" = "true" ]; then
  if node -e "
    const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient();
    db.organization.count()
      .then((n) => process.exit(n === 0 ? 0 : 1))
      .catch(() => process.exit(1))
      .finally(() => db.\$disconnect());
  "; then
    echo "→ Empty database — loading shops, suppliers and product catalogue"
    $TSX prisma/seed.ts || echo "  seed failed, continuing"
  else
    echo "→ Database already holds data, skipping seed"
  fi
fi

echo "→ Starting API"
exec node dist/main.js
