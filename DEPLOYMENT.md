# Getting Intoto ERP online

Two options. Read the first section either way — it explains why `localhost` did not open.

---

## Why `http://localhost:3000` did not work

`localhost` means **the computer you are sitting at**. That address only works when the
app is running on *your* machine. Nothing is broken — there is simply nothing running
there yet.

You have two choices:

| | What you get | Cost | Effort |
|---|---|---|---|
| **A. Run on your computer** | Works offline, fast, private | Free | ~20 min setup |
| **B. Put it online** | A real link, works on your phone, staff can use it | Free tier available | ~30 min setup |

---

## Option A — run it on your own computer

Install these first:

- **Node.js 22** — https://nodejs.org (pick the LTS download)
- **Docker Desktop** — https://docker.com/products/docker-desktop
- **Git** — https://git-scm.com

Then open a terminal (Command Prompt on Windows, Terminal on Mac):

```bash
git clone https://github.com/abdulrahmansankyu-glitch/shop-intoto.git
cd shop-intoto
git checkout claude/intoto-erp-system-design-4m9rro

npm install -g pnpm
pnpm install

cp .env.example .env          # Windows: copy .env.example .env

docker compose up -d postgres redis

pnpm --filter @intoto/shared build
pnpm db:push
pnpm db:seed

pnpm dev
```

Now http://localhost:3000 opens. Sign in with **owner@intoto.in** / **Intoto@2025**.

> Change that password immediately if you put real business data in.

---

## Option B — put it online (free tier)

Three free services. Netlify alone is not enough — it cannot run the backend or store
data.

| Piece | Service | Free tier limit |
|---|---|---|
| Database | **Neon** | 0.5 GB — enough for years of a 3-shop business |
| Backend API | **Render** | Sleeps after 15 min idle; first request then takes ~50s |
| Frontend | **Netlify** | 100 GB bandwidth/month |

### Step 1 — Database (Neon)

1. Sign up at https://neon.tech
2. Create a project, region **Singapore** (closest to India)
3. Copy the connection string — looks like
   `postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`

### Step 2 — Backend (Render)

1. Sign up at https://render.com and connect your GitHub
2. **New → Blueprint**, pick this repository, branch
   `claude/intoto-erp-system-design-4m9rro`. It reads `render.yaml`.
3. Set these environment variables:
   - `DATABASE_URL` — the Neon string from step 1
   - `FIELD_ENCRYPTION_KEY` — run `openssl rand -base64 32` and paste the result
   - `APP_URL` — leave blank for now; fill it in after step 3
4. Deploy. You get a URL like `https://intoto-api.onrender.com`.
5. Check it works: open `https://intoto-api.onrender.com/api/v1/health` — it should
   reply `{"status":"ok"}`.

### Step 3 — Frontend (Netlify)

1. Sign up at https://netlify.com and connect GitHub
2. **Add new site → Import an existing project**, pick this repository and the same
   branch. It reads `netlify.toml`.
3. Add one environment variable:
   - `NEXT_PUBLIC_API_URL` = `https://intoto-api.onrender.com/api/v1`
4. Deploy. You get a URL like `https://intoto-erp.netlify.app` — **this is your link.**

### Step 4 — Connect them

Go back to Render and set `APP_URL` to your Netlify URL, then redeploy. Without this the
browser blocks the frontend from calling the API and every screen stays empty.

### Step 5 — Load the starting data

In Render, open the **Shell** tab on the API service:

```bash
node ../../node_modules/prisma/build/index.js db push --schema prisma/schema.prisma
npx tsx prisma/seed.ts
```

This creates your 3 shops, 20 suppliers, product catalogue and user accounts.

---

## Free tier — the honest limits

**The backend sleeps.** Render's free tier shuts the API down after 15 minutes of no
use. The next person to open the app waits ~50 seconds while it restarts. Fine for
showing people; irritating at a billing counter with a customer waiting.

**Fix:** Render's paid tier is **$7/month (~₹600)** and never sleeps. Worth it the day
you start billing real customers.

**Back up your data.** Neon's free tier keeps 24 hours of history. Once you have real
sales in there, take a weekly backup:

```bash
pg_dump "<your Neon connection string>" > backup-$(date +%F).sql
```

---

## Security before real business data

1. **Change every seeded password.** They are published in this file.
2. **Set `FIELD_ENCRYPTION_KEY`** — without it supplier bank details sit in plain text.
3. **Turn on two-factor** for the owner account (Settings → Security).
4. **Never commit `.env`** — it is git-ignored; keep it that way.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Screens load but stay empty | `NEXT_PUBLIC_API_URL` wrong, or `APP_URL` not set on Render | Check both, redeploy |
| "Session expired" immediately | `JWT_ACCESS_SECRET` changed between deploys | Sign in again |
| First load takes ~50s | Free tier woke from sleep | Normal; upgrade to remove |
| Login says wrong password | Seed never ran | Run step 5 |
| API health check fails | `DATABASE_URL` wrong or Neon asleep | Open the Neon dashboard, verify the string |
