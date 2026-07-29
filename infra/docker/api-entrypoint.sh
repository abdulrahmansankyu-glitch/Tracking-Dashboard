#!/bin/sh
# Boot sequence for the Intoto ERP API.
#
# Runs before the server accepts traffic, so the process never serves against a schema it
# does not match, and a fresh deployment is usable the moment it finishes rather than
# presenting a login screen with no accounts to sign in with.
set -e

echo "→ Applying database migrations"
node /app/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma

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
    node /app/node_modules/tsx/dist/cli.mjs prisma/seed.ts || echo "  seed failed, continuing"
  else
    echo "→ Database already holds data, skipping seed"
  fi
fi

echo "→ Starting API"
exec node dist/main.js
