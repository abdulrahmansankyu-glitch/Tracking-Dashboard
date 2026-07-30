#!/bin/sh
# Start the Intoto ERP API on Render's native Node runtime.
#
# A shell script rather than a chain of && in render.yaml, so that when something fails
# the log names the step that failed instead of one long unreadable command.
set -e

cd apps/api

# Resolved through the package's own bin directory: pnpm does not hoist everything to a
# single top-level node_modules, so an absolute path elsewhere is not dependable.
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

echo "→ Starting API on port ${PORT:-4000}"
exec node dist/main.js
