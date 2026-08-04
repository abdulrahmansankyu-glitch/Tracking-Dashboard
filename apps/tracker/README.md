# Engineering Activity Tracker

Shared daily tracking for engineering jobs across seven registers, with the team's
Excel workbooks as the way data goes in and comes out.

Everyone opens the **same URL** and sees the **same live data**. When someone
uploads a sheet or edits a job, it is there for the rest of the team on their next
refresh — no emailing workbooks around to find out which copy is current.

---

## What it tracks

| Register | What it holds | Due date comes from |
|---|---|---|
| Action Notice | Action notices raised on plant equipment | ETC |
| IWS | Inspection work scopes | Target Date |
| PZV | Safety-valve calibration and overhaul | Due Date |
| EIS | Equipment inspection strategy (vessels, tanks) | Next Inspection |
| Routine Inspection | Recurring routines by interval | Next Inspec Date |
| CTS Recommendation | Recommendations from CTS investigations | ETC |
| PDM | Predictive maintenance findings (VA, OA) | Target Date |

Each register keeps **its own columns** — an IWS row really is not a PDM row, and
flattening them would lose the Notification and WO numbers, the calibration dates
and the vibration findings that make each sheet worth keeping.

What makes one dashboard possible is that every register declares which of its own
columns answers each shared question: *what is this, who owns it, when is it due,
how urgent is it.* That mapping lives in one place —
[`src/registers.js`](src/registers.js) — and adding an eighth register is a change
to that file and nothing else.

---

## The dashboard

- **Open · Overdue · Due in 30 days · No due date · Completed** across everything.
- **When work is due** — overdue, within 7 days, 8–14, 15–30, beyond 30, undated.
- **Open jobs by priority**, on one ladder shared by all seven registers.
- **Workload by action owner** — who is carrying what, most overdue first.
- **Needs attention** — everything overdue or due inside a month, soonest first.
- **Recent changes** — who changed what, and when.

Priority, status, action owner, initiator and due window are all filterable inside
each register, and the table sorts on any column.

---

## Excel import

Upload a workbook and **every sheet becomes its own choice**. For each one you pick
the register it belongs to and whether to *replace* that register or *add* to it.

The reader is built around the team's real files rather than an idealised table:

- **The header row is found, not assumed.** Row 1 in these files is a merged banner
  (`Solid Handling Plant's IWS Track`), so the header is on row 2 — and it is
  located by matching column names, not by counting rows.
- **Columns are found by position.** `Routine Inspection` starts in column B.
- **Spelling drift is expected.** `Action By ` with a trailing space, `Refrence`,
  `Plan date for callibration` — matching ignores case, spacing and punctuation, and
  each field carries the spellings seen in the real workbooks.
- **Blank rows stay blank.** The Action Notice sheet carries pre-numbered empty rows
  20–31 waiting for next month; a serial number alone never makes a job.
- **Unknown columns are kept**, not dropped, and are editable in the app.
- **Phrases in date columns survive.** `Next Shutdown` and `SEP` are real, deliberate
  entries. They are kept and shown; the job simply has no calendar date behind it.
- **Impossible dates are refused.** The EIS sheet holds several `1935-03-25` values
  where a five-year addition wrapped. Accepting them would park permanently overdue
  rows at the top of every dashboard, so they are kept as text and left undated.

Sheet names alone never decide a register — both uploaded workbooks contain a sheet
called `Sheet1`. Columns decide; the name only breaks a tie.

## Excel export

**Export all** produces one workbook: a Summary sheet plus one sheet per register,
laid out like the Engineering Master file it replaces, with overdue rows tinted red
and due-soon rows amber so the state is visible in Excel too.

Exports **re-import cleanly** — download the master file, edit it offline, upload it
back. The columns the app adds (`Tracker Priority`, `Days To Due`, …) are ignored on
the way back in, so a round trip neither duplicates columns nor loses rows.

**Blank template** gives an empty workbook with the right headers for one register —
the quickest way to start one from scratch.

---

## Running it

```bash
pnpm install
pnpm --filter @intoto/tracker dev      # http://localhost:4100
```

With no `DATABASE_URL`, data goes to `apps/tracker/data/tracker.json` — good for
trying it out on one machine, and gitignored. Point `DATABASE_URL` at Postgres and
it uses that instead; the tables are created on boot.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4100` | Port to listen on |
| `DATABASE_URL` | — | Postgres connection string. Unset → local JSON file |
| `DATABASE_SSL` | — | `no-verify` for managed Postgres (Neon, Supabase, Render external); `disable` to force plain TCP |
| `TRACKER_ACCESS_CODE` | — | Shared team code. Unset → anyone with the link can edit |
| `TRACKER_DATA_FILE` | `data/tracker.json` | Where the JSON store lives |

```bash
pnpm --filter @intoto/tracker test     # 21 tests, no database needed
```

---

## Deploying it

The blueprint in [`render.yaml`](../../render.yaml) defines an `intoto-tracker`
service. It shares the existing free Postgres instance but keeps its tables in a
separate `tracker` schema, so the ERP's `prisma db push` — which drops tables in
`public` it does not know about — cannot reach them.

There is no build step: the tracker is plain JavaScript on both sides, so a deploy
is an install and a start.

Two things worth knowing about Render's free tier before the team relies on it:
services sleep after 15 minutes idle and take about 50 seconds to wake, and **the
free database is deleted after 30 days**. Before this holds work you cannot lose,
move to a paid database or to Neon's free tier, which persists.

---

## Who can see it

Access is a **shared team code**, not per-person accounts. The team already emails
these workbooks around; making everyone maintain a password to reach a tracker they
can already read would add administration without adding privacy.

Each person types their name once. It is recorded against everything they add or
change and shown in *Recent changes*, which is the accountability the `Action By`
and `Initiator` columns are asking for.

If you need real per-person accounts — someone who may read but not edit, or an
audit trail that a person cannot type their way around — that needs actual user
records, and this is the point to add them rather than to stretch the shared code.

---

## How it is built

Plain ES modules, no build step and no framework, on both sides. The file in the
repository is the file that runs: open `public/app.js`, change it, reload.

```
src/registers.js   the seven registers, and how each maps onto the shared shape
src/excel.js       reading real workbooks; writing ones that read back in
src/store.js       Postgres or a JSON file, behind one interface
src/server.js      the API and the static app, one process
public/            the browser app — app.js, styles.css, index.html
test/              21 tests over the parts that would fail silently
```

The browser never carries its own copy of the register definitions — it reads them
from `/api/config`, so the columns, their labels and their types have exactly one
source of truth.
