# Intoto ERP

AI-powered ERP for **Intoto** — clothing wholesale & retail, India. Built to run 3 shops today and an unlimited number of branches without an architecture change.

> **Status:** you can run the shop on it. Stock in, sell over the counter with correct
> GST, and see real profit. Verified end to end in a browser, not just written.
>
> **New here? Read [DEPLOYMENT.md](DEPLOYMENT.md)** — it covers running it on your own
> computer and putting it online on free hosting.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind v4 | App Router, server components, 3D via React Three Fiber |
| Backend | NestJS 10, TypeScript | Module boundaries that survive a system this size |
| Database | PostgreSQL 16 + Prisma 6 | Exact decimal money, strong indexing, mature ecosystem |
| Cache/queue | Redis 7 | Sessions, rate limits, background jobs |
| Storage | AWS S3 (MinIO-compatible) | Documents, invoices, product media |
| AI | Anthropic Claude | Advisor, forecasting, natural-language search |

---

## Quick start

```bash
# 1. Install
pnpm install

# 2. Configure
cp .env.example .env          # then fill in secrets (see below)

# 3. Start Postgres + Redis
docker compose up -d postgres redis

# 4. Create the schema
pnpm --filter @intoto/shared build
pnpm db:push

# 5. Run
pnpm dev
```

| Service | URL |
|---|---|
| Web | http://localhost:3000 |
| API | http://localhost:4000/api/v1 |
| API docs (Swagger) | http://localhost:4000/api/v1/docs |

**Required secrets** — generate real values, never ship the examples:

```bash
openssl rand -hex 32      # JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
openssl rand -base64 32   # FIELD_ENCRYPTION_KEY (must decode to exactly 32 bytes)
```

Without `FIELD_ENCRYPTION_KEY` the API still runs but logs a warning and stores supplier bank details in plaintext.

<details>
<summary>No Docker? Use a local Postgres cluster</summary>

```bash
pg_ctlcluster 16 main start
su postgres -c "psql -c \"CREATE ROLE intoto LOGIN PASSWORD 'intoto_dev_password' SUPERUSER\""
su postgres -c "createdb -O intoto intoto_erp"
```
</details>

---

## Repository layout

```
apps/
  api/                  NestJS backend
    prisma/schema.prisma  ← the data model (single source of truth)
    src/common/           cross-cutting infrastructure
    src/modules/          business domains
  web/                  Next.js frontend
  tracker/              Engineering Activity Tracker (separate app — see below)
packages/
  shared/               GST engine, money, RBAC, Zod schemas — used by BOTH tiers
infra/                  Docker, Kubernetes, Postgres init
docs/                   architecture, ER diagram, API, manuals
```

---

## Design decisions worth knowing

These are the choices that shape everything else.

**Money is never a float.** Stored as `Decimal(18,4)`, computed as integer paise. A ₹0.01 rounding drift per line becomes a trial balance that does not balance.

**The GST engine lives in `packages/shared`.** The POS and the API import the *same* functions, so the total a cashier sees and the total filed in GSTR-1 cannot diverge. It handles the value-dependent textile slab (apparel ≤ ₹1,000 → 5%, above → 12%), intra- vs inter-state splits, inclusive/exclusive pricing, and invoice-level discount apportionment.

**Ledgers are append-only.** `StockMovement` and `JournalLine` are never updated or deleted — corrections are new reversing rows. Stock and books at any past date are reconstructible.

**Tenancy from day one.** Every business table carries `organizationId`. Adding shop #4 or shop #400 is an `INSERT`, not a migration.

**Delete and archive are different.** `deletedAt` hides a row recoverably; `archivedAt` retires it while keeping it fully reportable. Accountants need both, and the spec asks for both.

**Cost of goods is frozen at sale time.** `SalesInvoice.costOfGoodsSold` is written when the sale posts, so per-invoice and per-supplier profit is exact and immune to later cost changes.

**Secure by default.** Auth, permission and shop-scope guards are global. A new endpoint is protected unless it explicitly opts out with `@Public()` — visible in review, unlike a forgotten decorator.

**Generic CRUD, not sixty copies.** `BaseCrudService` gives every resource list/search/filter/sort/paginate, create, update, soft-delete, archive, restore and audit history. Domain services add only what is genuinely theirs.

---

## Commands

```bash
pnpm dev              # api + web
pnpm build            # shared → api → web
pnpm typecheck        # all packages
pnpm test             # all packages

pnpm db:push          # sync schema (development)
pnpm db:migrate       # create a migration
pnpm db:studio        # browse data
pnpm db:seed          # demo data: 3 shops, 20 suppliers
```

---

## What works

Everything below is verified against a real database, in a browser.

- [x] **Sign in** — 8 roles, permissions enforced per shop, optional 2FA
- [x] **Products, Suppliers, Customers, Shops** — add, edit, delete, archive,
      restore, search, filter, sort, Excel/CSV/PDF export, print, audit history
- [x] **Stock** — receive, adjust for damage or miscount, transfer between shops
- [x] **Billing (POS)** — scan or search, live GST total, cash/UPI/card,
      printable tax invoice, refuses to oversell
- [x] **Profit** — computed from what each item actually cost you at the moment
      it sold
- [x] **Dashboard** — 3D shop comparison and charts *(figures are still sample
      data until more sales exist)*

### Not built

Purchase orders · double-entry accounting · GST return filing · expenses ·
employees & payroll · notifications (WhatsApp/SMS) · AI advisor · mobile apps ·
e-invoice (IRP)

The database already models all of these — they need their screens and business
logic.

---

## Also in this repository: the Engineering Activity Tracker

`apps/tracker/` is a **separate application for a different business** — daily job
tracking for a solid handling plant (SHP / DCU), across seven registers: Action
Notice, IWS, PZV, EIS, Routine Inspection, CTS Recommendation and PDM. It shares
this repository and the Postgres instance; it shares no code and no domain with the
clothing ERP above, and it deploys to its own URL as `intoto-tracker`.

The team works in Excel, so the workbook is how data moves: upload a file and every
sheet becomes its own choice of register, work in the app, export the whole thing
back as one master workbook that re-imports cleanly.

```bash
pnpm dev:tracker      # http://localhost:4100
```

Full documentation: **[apps/tracker/README.md](apps/tracker/README.md)**.

---

## Licence

Proprietary — © Intoto. All rights reserved.
