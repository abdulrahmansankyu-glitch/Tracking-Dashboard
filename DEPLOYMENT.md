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

## Option B — put it online (free)

**Netlify cannot host this on its own.** It serves files and short serverless functions;
it has no database and cannot keep a backend process running. The same is true of
GitHub Pages and Vercel's free tier. This system needs a database and a long-lived
server, so it needs a host that provides both.

Render provides all three pieces — database, backend, screens — from one file, and the
free tier covers it.

### Steps

1. Sign up at https://render.com and connect your GitHub account.
2. Go to https://dashboard.render.com/blueprints → **New Blueprint Instance**.
3. Pick **shop-intoto**, set **Branch** to
   `claude/intoto-erp-system-design-4m9rro`, give it a name, click **Apply**.
4. Wait for `intoto-api` and `intoto-web` to both report **Live** (about 10 minutes).
5. Open `intoto-web` and click the URL at the top. **That is your link.**
6. Sign in as **owner@intoto.in** / **Intoto@2025**, then change that password.

Nothing else to configure. The blueprint generates the secrets, connects the services to
each other, applies the database schema, and loads your 3 shops, 20 suppliers and product
catalogue on first boot.

### Why this does not use Docker

Earlier versions built Docker images and failed twice on the seams between pnpm's
symlinked `node_modules` and the image build. Render's native Node runtime runs the same
commands the project uses in development, so there is far less between the source and a
running process — and when something does break, the log names the command that broke.

The Dockerfiles under `infra/docker/` are kept for self-hosting on your own server; the
blueprint no longer uses them.

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
