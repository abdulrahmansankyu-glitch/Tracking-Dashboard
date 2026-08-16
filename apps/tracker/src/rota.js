/**
 * The safety duty rota — who covers which task, in which area, in which week.
 *
 * Three rotas the team used to keep by hand in a spreadsheet:
 *
 *   * **Safety KPI** — every week each task (WPA, UCO, BOP, SM) needs its target
 *     filled in both SHP and DCU.
 *   * **Internal walkthrough** — two people walk each area every Monday.
 *   * **Weekend coverage** — one person covers each Saturday.
 *
 * Everything here is pure: the fill takes a document and returns a new one. That
 * is what lets the same code run on the server for the hosted deployment and be
 * inlined into the standalone single-file build, the way `registers.js` and
 * `query.js` already are — the offline copy cannot drift from the deployed one
 * because there is only one copy of the logic.
 *
 * The document is stored whole, as one JSON value in `tracker.settings`. It is a
 * few kilobytes for a year of weeks, it is always read and written as a unit, and
 * keeping it out of its own tables means no migration to deploy and no second
 * storage path to keep working on the JSON-file backend.
 */

export const AREAS = ['SHP', 'DCU'];

/** Bounds. Generous for a plant team, small enough that the document stays a document. */
const MAX_PEOPLE = 60;
const MAX_TASKS = 12;
const MAX_WEEKS = 53;
const MAX_PER_AREA = 8;

/**
 * The team and the targets the rota started from, read off the spreadsheet it
 * replaces. All of it is editable in the app — this is a starting point, not a
 * fixed list.
 */
const SEED_PEOPLE = [
  'Ahmed Malainine',
  'Nandy',
  'Essam',
  'Abdulrahman',
  'Rehan',
  'Aslam',
  'Faiz',
  'Ahmed Al subhi',
];

const SEED_TASKS = [
  { key: 'WPA', SHP: 2, DCU: 2 },
  { key: 'UCO', SHP: 1, DCU: 1 },
  { key: 'BOP', SHP: 1, DCU: 1 },
  { key: 'SM', SHP: 1, DCU: 1 },
];

// ------------------------------------------------------------------ dates ---
//
// Every date is a UTC midnight `Date`. The plant's own timezone decides which
// week "today" falls in (TZ is set on the service), but the rota's own arithmetic
// stays in UTC so a deployment in another zone cannot shift a Monday by a day.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function todayUtc(now = new Date()) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function parseIsoDate(value) {
  const parts = String(value ?? '')
    .split('-')
    .map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toIsoDate(date) {
  return (
    `${date.getUTCFullYear()}-` +
    `${String(date.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(date.getUTCDate()).padStart(2, '0')}`
  );
}

export function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** The Monday of the week `date` falls in. */
export function mondayOf(date) {
  return addDays(date, -((date.getUTCDay() + 6) % 7));
}

/** `3-Aug-26` — the form the team already reads on the printed sheet. */
export function formatDate(date) {
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${String(date.getUTCFullYear()).slice(2)}`;
}

/** `3 Aug` — for a range where the year is already obvious. */
export function formatShort(date) {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/**
 * ISO-8601 week number.
 *
 * Anchored on the Thursday of the week, which is what makes the year come out
 * right at the boundary: 28 Dec 2026 is 2026-W53, and 4 Jan 2027 is 2027-W01.
 */
export function isoWeek(date) {
  const thursday = addDays(date, -((date.getUTCDay() + 6) % 7) + 3);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((thursday - jan4) / 86400000 / 7);
  return { year, week };
}

export function weekKeyOf(date) {
  const { year, week } = isoWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function weekLabelOf(date) {
  return `W${String(isoWeek(date).week).padStart(2, '0')}`;
}

/** The Mondays covered by the document's window, in order. */
export function mondaysOf(doc) {
  const start = mondayOf(parseIsoDate(doc.startISO) ?? todayUtc());
  return Array.from({ length: doc.weeks }, (_, i) => addDays(start, i * 7));
}

/** The Saturday of each week in the window. */
export function saturdaysOf(doc) {
  return mondaysOf(doc).map((monday) => addDays(monday, 5));
}

/**
 * Every week in the window, already labelled and formatted.
 *
 * The browser draws the grid from this rather than working out ISO weeks for
 * itself. Week numbering is the one piece of arithmetic here with a genuinely
 * surprising edge — 2026 has a W53 — and it should have a single implementation,
 * the same way the register definitions do.
 */
export function calendarOf(doc) {
  return mondaysOf(doc).map((monday) => {
    const saturday = addDays(monday, 5);
    return {
      week: weekKeyOf(monday),
      label: weekLabelOf(monday),
      mondayIso: toIsoDate(monday),
      mondayText: formatDate(monday),
      saturdayIso: toIsoDate(saturday),
      saturdayText: formatDate(saturday),
      range: `${formatShort(monday)} – ${formatShort(addDays(monday, 6))}`,
    };
  });
}

// --------------------------------------------------------------- document ---

export function defaultRota(now = new Date()) {
  return normaliseRota({
    people: SEED_PEOPLE.map((name, i) => ({
      id: `p${i + 1}`,
      name,
      active: true,
    })),
    tasks: SEED_TASKS,
    startISO: toIsoDate(mondayOf(todayUtc(now))),
    weeks: 8,
    wtPerArea: 2,
    wePerDate: 1,
  });
}

const asList = (value) => (Array.isArray(value) ? value : []);

const clampNumber = (value, min, max, fallback) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Coerce anything that arrives over the wire into a document the rest of the
 * module can rely on.
 *
 * This is the only validation there is, so it has to be total: unknown people are
 * dropped from every assignment, targets are clamped, and the start date is
 * snapped back to a Monday. A saved rota that references a deleted person would
 * otherwise render as a blank name for as long as nobody re-filled that week.
 */
export function normaliseRota(input = {}) {
  const source = input && typeof input === 'object' ? input : {};

  const usedIds = new Set();
  const people = asList(source.people)
    .slice(0, MAX_PEOPLE)
    .map((person, index) => {
      const name = String(person?.name ?? '')
        .trim()
        .slice(0, 80);
      let id = String(person?.id ?? '')
        .trim()
        .slice(0, 40);
      if (!id || usedIds.has(id)) id = `p${index + 1}`;
      while (usedIds.has(id)) id = `${id}x`;
      usedIds.add(id);
      return { id, name, active: person?.active !== false };
    })
    .filter((person) => person.name);

  const known = new Set(people.map((person) => person.id));

  const usedKeys = new Set();
  const tasks = asList(source.tasks)
    .slice(0, MAX_TASKS)
    .map((task, index) => {
      let key = String(task?.key ?? '')
        .trim()
        .toUpperCase()
        .slice(0, 12);
      if (!key || usedKeys.has(key)) key = `TASK${index + 1}`;
      while (usedKeys.has(key)) key = `${key}X`;
      usedKeys.add(key);
      return {
        key,
        SHP: clampNumber(task?.SHP, 0, MAX_PER_AREA, 1),
        DCU: clampNumber(task?.DCU, 0, MAX_PER_AREA, 1),
      };
    });

  const start = mondayOf(parseIsoDate(source.startISO) ?? todayUtc());

  /** Keep only real people, without duplicates, and never more than the team. */
  const cleanIds = (value) => {
    const out = [];
    for (const id of asList(value)) {
      const key = String(id);
      if (known.has(key) && !out.includes(key)) out.push(key);
      if (out.length >= people.length) break;
    }
    return out;
  };

  const kpiData = {};
  const rawKpi = source.kpi?.data ?? {};
  for (const week of Object.keys(rawKpi ?? {})) {
    const byTask = {};
    for (const task of tasks) {
      const bucket = rawKpi[week]?.[task.key];
      if (!bucket) continue;
      const areas = {};
      for (const area of AREAS) {
        const ids = cleanIds(bucket[area]);
        if (ids.length) areas[area] = ids;
      }
      if (Object.keys(areas).length) byTask[task.key] = areas;
    }
    if (Object.keys(byTask).length) kpiData[week] = byTask;
  }

  const wtData = {};
  for (const [date, slot] of Object.entries(source.wt?.data ?? {})) {
    const areas = {};
    for (const area of AREAS) {
      const ids = cleanIds(slot?.[area]);
      if (ids.length) areas[area] = ids;
    }
    if (Object.keys(areas).length) wtData[date] = areas;
  }

  const weData = {};
  for (const [date, ids] of Object.entries(source.we?.data ?? {})) {
    const clean = cleanIds(ids);
    if (clean.length) weData[date] = clean;
  }

  /** Locks are a flat set of "which groups did a person set by hand". */
  const cleanLocks = (value) => {
    const out = {};
    for (const [key, on] of Object.entries(value ?? {})) {
      if (on === true) out[String(key).slice(0, 80)] = true;
    }
    return out;
  };

  return {
    rev: clampNumber(source.rev, 0, Number.MAX_SAFE_INTEGER, 0),
    people,
    tasks,
    startISO: toIsoDate(start),
    weeks: clampNumber(source.weeks, 1, MAX_WEEKS, 8),
    wtPerArea: clampNumber(source.wtPerArea, 1, MAX_PER_AREA, 2),
    wePerDate: clampNumber(source.wePerDate, 1, 4, 1),
    kpi: { data: kpiData, locked: cleanLocks(source.kpi?.locked) },
    wt: { data: wtData, locked: cleanLocks(source.wt?.locked) },
    we: { data: weData, locked: cleanLocks(source.we?.locked) },
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy.slice(0, 80) : null,
  };
}

// ------------------------------------------------------------------- fill ---
//
// One rule decides every slot: among the people still eligible for it, take
// whoever is carrying the least. Ties break by total load, then by who went
// longest without a turn, then by position on the team list — so the result is
// deterministic. Pressing Fill twice does not reshuffle the team, which matters
// more than it sounds: a rota that rearranges itself on every press is one nobody
// trusts enough to print.

function makeContext() {
  return { load: new Map(), last: new Map(), period: 0 };
}

function record(ctx, id, periodUse) {
  ctx.load.set(id, (ctx.load.get(id) ?? 0) + 1);
  ctx.last.set(id, ctx.period);
  if (periodUse) periodUse.set(id, (periodUse.get(id) ?? 0) + 1);
}

/**
 * Choose `count` people for one slot group.
 *
 * `periodUse` spreads work across the tasks *within* a week before it starts
 * doubling anyone up; `exclude` is the hard constraint (nobody twice in the same
 * task, nobody twice on the same walkthrough date); `extraLoad` is an optional
 * secondary balance, used to even out who walks which area.
 */
function choose(ctx, active, count, options = {}) {
  const periodUse = options.periodUse ?? new Map();
  const taken = new Set(options.exclude ?? []);
  const extra = options.extraLoad ?? null;
  const order = new Map(active.map((person, index) => [person.id, index]));
  const chosen = [];

  for (let i = 0; i < count; i += 1) {
    const candidates = active.filter((person) => !taken.has(person.id));
    if (!candidates.length) break;

    candidates.sort(
      (a, b) =>
        (periodUse.get(a.id) ?? 0) - (periodUse.get(b.id) ?? 0) ||
        (ctx.load.get(a.id) ?? 0) - (ctx.load.get(b.id) ?? 0) ||
        (extra ? (extra.get(a.id) ?? 0) - (extra.get(b.id) ?? 0) : 0) ||
        (ctx.last.get(a.id) ?? -Infinity) - (ctx.last.get(b.id) ?? -Infinity) ||
        order.get(a.id) - order.get(b.id),
    );

    const pick = candidates[0].id;
    chosen.push(pick);
    taken.add(pick);
    record(ctx, pick, periodUse);
    if (extra) extra.set(pick, (extra.get(pick) ?? 0) + 1);
  }

  return chosen;
}

const clone = (doc) => JSON.parse(JSON.stringify(doc));

/**
 * Fill the rota, leaving hand-edited groups exactly as they are.
 *
 * A locked group still counts toward everyone's load, so the rest of the rota
 * works around a manual choice instead of ignoring it and handing that person a
 * double week.
 */
export function fillRota(input, parts = {}) {
  const doc = normaliseRota(input);
  const want = {
    kpi: parts.kpi !== false,
    wt: parts.wt !== false,
    we: parts.we !== false,
  };
  const active = doc.people.filter((person) => person.active);
  if (!active.length) return doc;

  const mondays = mondaysOf(doc);

  if (want.kpi) {
    const ctx = makeContext();
    doc.kpi.data = {};
    mondays.forEach((monday, index) => {
      const week = weekKeyOf(monday);
      ctx.period = index;
      const weekUse = new Map();
      const byTask = {};

      for (const task of doc.tasks) {
        const usedInTask = new Set();
        const areas = {};

        // Locked areas first, so their people are excluded from the rest of the task.
        for (const area of AREAS) {
          if (!doc.kpi.locked[`${week}|${task.key}|${area}`]) continue;
          const ids = (input?.kpi?.data?.[week]?.[task.key]?.[area] ?? [])
            .map(String)
            .filter((id) => doc.people.some((person) => person.id === id));
          areas[area] = ids;
          for (const id of ids) {
            usedInTask.add(id);
            record(ctx, id, weekUse);
          }
        }

        for (const area of AREAS) {
          if (doc.kpi.locked[`${week}|${task.key}|${area}`]) continue;
          const picked = choose(ctx, active, task[area], {
            periodUse: weekUse,
            exclude: usedInTask,
          });
          for (const id of picked) usedInTask.add(id);
          areas[area] = picked;
        }

        const kept = Object.fromEntries(Object.entries(areas).filter(([, ids]) => ids.length));
        if (Object.keys(kept).length) byTask[task.key] = kept;
      }

      if (Object.keys(byTask).length) doc.kpi.data[week] = byTask;
    });
  }

  if (want.wt) {
    const ctx = makeContext();
    const areaLoad = { SHP: new Map(), DCU: new Map() };
    doc.wt.data = {};
    mondays.forEach((monday, index) => {
      const date = toIsoDate(monday);
      ctx.period = index;
      const dayUse = new Map();
      const usedToday = new Set();
      const areas = {};

      for (const area of AREAS) {
        if (!doc.wt.locked[`${date}|${area}`]) continue;
        const ids = (input?.wt?.data?.[date]?.[area] ?? [])
          .map(String)
          .filter((id) => doc.people.some((person) => person.id === id));
        areas[area] = ids;
        for (const id of ids) {
          usedToday.add(id);
          record(ctx, id, dayUse);
          areaLoad[area].set(id, (areaLoad[area].get(id) ?? 0) + 1);
        }
      }

      for (const area of AREAS) {
        if (doc.wt.locked[`${date}|${area}`]) continue;
        const picked = choose(ctx, active, doc.wtPerArea, {
          periodUse: dayUse,
          exclude: usedToday,
          extraLoad: areaLoad[area],
        });
        for (const id of picked) usedToday.add(id);
        areas[area] = picked;
      }

      const kept = Object.fromEntries(Object.entries(areas).filter(([, ids]) => ids.length));
      if (Object.keys(kept).length) doc.wt.data[date] = kept;
    });
  }

  if (want.we) {
    const ctx = makeContext();
    doc.we.data = {};
    saturdaysOf(doc).forEach((saturday, index) => {
      const date = toIsoDate(saturday);
      ctx.period = index;

      if (doc.we.locked[date]) {
        const ids = (input?.we?.data?.[date] ?? [])
          .map(String)
          .filter((id) => doc.people.some((person) => person.id === id));
        if (ids.length) doc.we.data[date] = ids;
        for (const id of ids) record(ctx, id, null);
        return;
      }

      const picked = choose(ctx, active, doc.wePerDate, {});
      if (picked.length) doc.we.data[date] = picked;
    });
  }

  return doc;
}

// ------------------------------------------------------------------ reads ---

export const kpiAt = (doc, week, taskKey, area) => doc.kpi?.data?.[week]?.[taskKey]?.[area] ?? [];
export const walkthroughAt = (doc, dateIso, area) => doc.wt?.data?.[dateIso]?.[area] ?? [];
export const weekendAt = (doc, dateIso) => doc.we?.data?.[dateIso] ?? [];

/** Every duty one person holds across the window, in date order. */
export function dutiesFor(doc, personId) {
  const duties = [];

  for (const monday of mondaysOf(doc)) {
    const week = weekKeyOf(monday);
    const mondayIso = toIsoDate(monday);
    const saturday = addDays(monday, 5);

    for (const task of doc.tasks) {
      for (const area of AREAS) {
        if (kpiAt(doc, week, task.key, area).includes(personId)) {
          duties.push({
            week,
            kind: 'kpi',
            what: task.key,
            area,
            dateIso: null,
          });
        }
      }
    }

    for (const area of AREAS) {
      if (walkthroughAt(doc, mondayIso, area).includes(personId)) {
        duties.push({
          week,
          kind: 'walkthrough',
          what: 'Walkthrough',
          area,
          dateIso: mondayIso,
        });
      }
    }

    if (weekendAt(doc, toIsoDate(saturday)).includes(personId)) {
      duties.push({
        week,
        kind: 'weekend',
        what: 'Weekend cover',
        area: null,
        dateIso: toIsoDate(saturday),
      });
    }
  }

  return duties;
}

export function countsFor(doc, personId) {
  const duties = dutiesFor(doc, personId);
  const of = (kind) => duties.filter((duty) => duty.kind === kind).length;
  return {
    kpi: of('kpi'),
    walkthrough: of('walkthrough'),
    weekend: of('weekend'),
    total: duties.length,
  };
}

/** How many slots the targets ask for but nobody is filling. */
export function unfilledCount(doc) {
  let missing = 0;
  for (const monday of mondaysOf(doc)) {
    const week = weekKeyOf(monday);
    for (const task of doc.tasks) {
      for (const area of AREAS) {
        missing += Math.max(0, task[area] - kpiAt(doc, week, task.key, area).length);
      }
    }
  }
  return missing;
}

/**
 * What this week looks like — the answer to "who is on?", which is the question
 * the rota exists to stop people asking each other.
 *
 * Returns `null` when today falls outside the planned window, so the caller can
 * say so rather than showing a convincingly empty week.
 */
export function currentWeek(doc, now = new Date()) {
  const monday = mondayOf(todayUtc(now));
  const mondayIso = toIsoDate(monday);
  if (!mondaysOf(doc).some((m) => toIsoDate(m) === mondayIso)) return null;

  const week = weekKeyOf(monday);
  const saturday = addDays(monday, 5);
  const nameOf = (id) => doc.people.find((person) => person.id === id)?.name ?? '—';

  return {
    week,
    label: weekLabelOf(monday),
    mondayIso,
    saturdayIso: toIsoDate(saturday),
    range: `${formatShort(monday)} – ${formatShort(addDays(monday, 6))}`,
    tasks: doc.tasks.map((task) => ({
      key: task.key,
      areas: Object.fromEntries(
        AREAS.map((area) => [area, kpiAt(doc, week, task.key, area).map(nameOf)]),
      ),
    })),
    walkthrough: Object.fromEntries(
      AREAS.map((area) => [area, walkthroughAt(doc, mondayIso, area).map(nameOf)]),
    ),
    weekend: weekendAt(doc, toIsoDate(saturday)).map(nameOf),
  };
}
