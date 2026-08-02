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

# Seed when this deployment has not been seeded yet. The seed is idempotent, but checking
# first keeps a restart from re-upserting hundreds of rows.
#
# The test is for the seed's own marker rather than "is the database empty". An earlier
# version checked only whether an organization existed, which meant a database seeded
# before the seed learned to create opening stock could never acquire it: the org was
# there, so the seed was skipped forever and every shop stayed empty. Asking whether the
# seed's own rows are present answers the actual question, and cannot mistake a real
# business's data for something to overwrite.
if [ "$RUN_SEED_ON_BOOT" = "true" ]; then
  if node -e "
    const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient();
    Promise.all([
      db.organization.count(),
      db.stockMovement.count({ where: { referenceType: 'SEED' } }),
    ])
      .then(([orgs, seeded]) => process.exit(orgs === 0 || seeded === 0 ? 0 : 1))
      .catch(() => process.exit(1))
      .finally(() => db.\$disconnect());
  "; then
    echo "→ Loading shops, suppliers, product catalogue and opening stock"
    $TSX prisma/seed.ts || echo "  seed failed, continuing"
  else
    echo "→ Already seeded, skipping"
  fi
fi

echo "→ Starting API on port ${PORT:-4000}"
exec node dist/main.js
