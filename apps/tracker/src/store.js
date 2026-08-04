/**
 * Storage for tracker records.
 *
 * Two backends behind one interface:
 *
 *  * **Postgres** when `DATABASE_URL` is set — the shared deployment, where the
 *    whole team reads and writes the same rows.
 *  * **A JSON file** otherwise — so `pnpm dev` works with nothing installed and a
 *    reviewer can run the app before deciding to provision a database.
 *
 * The Postgres tables live in their own `tracker` schema rather than `public`.
 * The same database also carries the ERP's Prisma schema, and `prisma db push`
 * drops tables in `public` that its schema does not declare. A separate schema
 * puts these tables out of that blast radius.
 *
 * Filtering, sorting and paging happen in JavaScript for both backends, after
 * narrowing by register in SQL. These registers hold hundreds of rows each, not
 * millions, and one filtering implementation cannot disagree with itself the way
 * a SQL path and a JSON path would.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { CLOSED_STATUSES, DUE_SOON_DAYS, daysUntil } from './registers.js';

const DERIVED_COLUMNS = [
  'ref',
  'title',
  'due_date',
  'due_text',
  'issued_date',
  'closed_date',
  'priority',
  'priority_raw',
  'status',
  'status_raw',
  'action_by',
  'initiator',
  'area',
  'discipline',
  'location',
];

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS tracker;

CREATE TABLE IF NOT EXISTS tracker.records (
  id           text PRIMARY KEY,
  register     text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ref          text,
  title        text,
  due_date     date,
  due_text     text,
  issued_date  date,
  closed_date  date,
  priority     text,
  priority_raw text,
  status       text,
  status_raw   text,
  action_by    text,
  initiator    text,
  area         text,
  discipline   text,
  location     text,
  source       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);

CREATE INDEX IF NOT EXISTS records_register_idx ON tracker.records (register);
CREATE INDEX IF NOT EXISTS records_due_idx      ON tracker.records (due_date);
CREATE INDEX IF NOT EXISTS records_status_idx   ON tracker.records (status);

CREATE TABLE IF NOT EXISTS tracker.activity (
  id        text PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     text,
  action    text NOT NULL,
  register  text,
  record_id text,
  summary   text,
  detail    jsonb
);

CREATE INDEX IF NOT EXISTS activity_at_idx ON tracker.activity (at DESC);
`;

/** Shape a stored row (either backend) into the JSON the API serves. */
function toApi(row) {
  return {
    id: row.id,
    register: row.register,
    data: row.data ?? {},
    ref: row.ref ?? null,
    title: row.title ?? null,
    dueDate: asDateString(row.due_date),
    dueText: row.due_text ?? null,
    issuedDate: asDateString(row.issued_date),
    closedDate: asDateString(row.closed_date),
    priority: row.priority ?? 'Medium',
    priorityRaw: row.priority_raw ?? null,
    status: row.status ?? 'Not Started',
    statusRaw: row.status_raw ?? null,
    actionBy: row.action_by ?? null,
    initiator: row.initiator ?? null,
    area: row.area ?? null,
    discipline: row.discipline ?? null,
    location: row.location ?? null,
    source: row.source ?? null,
    createdAt: asIsoString(row.created_at),
    createdBy: row.created_by ?? null,
    updatedAt: asIsoString(row.updated_at),
    updatedBy: row.updated_by ?? null,
  };
}

/** `pg` hands back `Date` for a `date` column; the file store holds strings. */
function asDateString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
      value.getUTCDate(),
    ).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

function asIsoString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Build the storage row for a record, from derived values plus metadata. */
function toRow({ id, register, data, derived, source, actor, createdAt, createdBy }) {
  const now = new Date().toISOString();
  return {
    id: id ?? randomUUID(),
    register,
    data: data ?? {},
    ref: derived.ref,
    title: derived.title,
    due_date: derived.dueDate,
    due_text: derived.dueText,
    issued_date: derived.issuedDate,
    closed_date: derived.closedDate,
    priority: derived.priority,
    priority_raw: derived.priorityRaw,
    status: derived.status,
    status_raw: derived.statusRaw,
    action_by: derived.actionBy,
    initiator: derived.initiator,
    area: derived.area,
    discipline: derived.discipline,
    location: derived.location,
    source: source ?? 'manual',
    created_at: createdAt ?? now,
    created_by: createdBy ?? actor ?? null,
    updated_at: now,
    updated_by: actor ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared query logic — applied identically whichever backend loaded the rows.
// ---------------------------------------------------------------------------

const SORTABLE = new Set([
  'dueDate',
  'priority',
  'status',
  'ref',
  'title',
  'actionBy',
  'initiator',
  'area',
  'updatedAt',
  'createdAt',
]);

const PRIORITY_RANK = { Critical: 1, High: 2, Medium: 3, Low: 4, Planned: 5 };

function matches(record, q) {
  if (q.register && record.register !== q.register) return false;

  if (q.search) {
    const needle = q.search.toLowerCase();
    const haystack = [
      record.ref,
      record.title,
      record.actionBy,
      record.initiator,
      record.area,
      record.location,
      record.discipline,
      ...Object.values(record.data ?? {}).map((v) => (v == null ? '' : String(v))),
    ]
      .join('  ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  if (q.priority?.length && !q.priority.includes(record.priority)) return false;
  if (q.status?.length && !q.status.includes(record.status)) return false;

  if (q.actionBy?.length) {
    const value = (record.actionBy ?? '').toLowerCase();
    if (!q.actionBy.some((a) => a.toLowerCase() === value)) return false;
  }

  if (q.initiator?.length) {
    const value = (record.initiator ?? '').toLowerCase();
    if (!q.initiator.some((a) => a.toLowerCase() === value)) return false;
  }

  if (q.area?.length) {
    const value = (record.area ?? '').toLowerCase();
    if (!q.area.some((a) => a.toLowerCase() === value)) return false;
  }

  // `open` is the default working view: anything nobody has closed out.
  if (q.open && CLOSED_STATUSES.has(record.status)) return false;

  if (q.due) {
    const closed = CLOSED_STATUSES.has(record.status);
    const days = record.dueDate ? daysUntil(record.dueDate) : null;
    if (q.due === 'overdue' && !(!closed && days !== null && days < 0)) return false;
    if (q.due === 'due-soon' && !(!closed && days !== null && days >= 0 && days <= DUE_SOON_DAYS)) {
      return false;
    }
    if (q.due === 'undated' && record.dueDate) return false;
    if (q.due === 'dated' && !record.dueDate) return false;
  }

  return true;
}

/**
 * Order two records, with a deterministic tiebreak.
 *
 * Neither backend returns rows in a guaranteed order, and Postgres in particular
 * relocates a tuple when it is updated. Without a final tiebreak, saving one row
 * silently reshuffles every other row that shares its due date — the row you just
 * edited appears to jump somewhere else in the table.
 */
function compare(a, b, sort, direction) {
  const primary = comparePrimary(a, b, sort, direction);
  return primary !== 0 ? primary : a.id.localeCompare(b.id);
}

function comparePrimary(a, b, sort, direction) {
  const sign = direction === 'desc' ? -1 : 1;

  if (sort === 'priority') {
    return sign * ((PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));
  }

  if (sort === 'dueDate') {
    // Undated rows sort last in both directions. They are not "far future" work —
    // they are work with no date, and burying them under a descending sort would
    // hide them exactly when someone is looking for what to schedule next.
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return sign * a.dueDate.localeCompare(b.dueDate);
  }

  const av = a[sort];
  const bv = b[sort];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return sign * String(av).localeCompare(String(bv), undefined, { numeric: true });
}

function applyQuery(records, query = {}) {
  const q = {
    register: query.register || null,
    search: query.search ? String(query.search).trim().toLowerCase() : '',
    priority: asArray(query.priority),
    status: asArray(query.status),
    actionBy: asArray(query.actionBy),
    initiator: asArray(query.initiator),
    area: asArray(query.area),
    due: query.due || null,
    open: query.open === true || query.open === 'true',
  };

  const filtered = records.filter((r) => matches(r, q));

  const sort = SORTABLE.has(query.sort) ? query.sort : 'dueDate';
  const direction = query.direction === 'desc' ? 'desc' : 'asc';
  filtered.sort((a, b) => compare(a, b, sort, direction));

  const total = filtered.length;
  const pageSize = clampInt(query.pageSize, 1, 500, 50);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(query.page, 1, pageCount, 1);
  const start = (page - 1) * pageSize;

  return { rows: filtered.slice(start, start + pageSize), total, page, pageSize, pageCount };
}

function asArray(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((v) => String(v).trim())
    .filter(Boolean);
  return list.length ? list : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

class PostgresStore {
  constructor(pool) {
    this.pool = pool;
    this.kind = 'postgres';
  }

  async init() {
    await this.pool.query(SCHEMA_SQL);
  }

  async #load(register) {
    const { rows } = register
      ? await this.pool.query('SELECT * FROM tracker.records WHERE register = $1', [register])
      : await this.pool.query('SELECT * FROM tracker.records');
    return rows.map(toApi);
  }

  async list(query = {}) {
    return applyQuery(await this.#load(query.register), query);
  }

  async all(register = null) {
    return this.#load(register);
  }

  async get(id) {
    const { rows } = await this.pool.query('SELECT * FROM tracker.records WHERE id = $1', [id]);
    return rows.length ? toApi(rows[0]) : null;
  }

  async insertMany(rows) {
    if (!rows.length) return 0;
    const columns = ['id', 'register', 'data', ...DERIVED_COLUMNS, 'source', 'created_at', 'created_by', 'updated_at', 'updated_by'];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Chunked so a large sheet cannot exceed Postgres' 65535 bind-parameter limit.
      const perStatement = Math.max(1, Math.floor(60000 / columns.length));
      for (let i = 0; i < rows.length; i += perStatement) {
        const chunk = rows.slice(i, i + perStatement);
        const values = [];
        const placeholders = chunk.map((row, r) => {
          const slots = columns.map((col, c) => {
            values.push(col === 'data' ? JSON.stringify(row[col] ?? {}) : row[col] ?? null);
            return `$${r * columns.length + c + 1}`;
          });
          return `(${slots.join(', ')})`;
        });
        await client.query(
          `INSERT INTO tracker.records (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`,
          values,
        );
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateRow(row) {
    const columns = ['register', 'data', ...DERIVED_COLUMNS, 'source', 'updated_at', 'updated_by'];
    const assignments = columns.map((col, i) => `${col} = $${i + 2}`);
    const values = columns.map((col) => (col === 'data' ? JSON.stringify(row[col] ?? {}) : row[col] ?? null));
    await this.pool.query(
      `UPDATE tracker.records SET ${assignments.join(', ')} WHERE id = $1`,
      [row.id, ...values],
    );
    return this.get(row.id);
  }

  async remove(id) {
    const { rowCount } = await this.pool.query('DELETE FROM tracker.records WHERE id = $1', [id]);
    return rowCount > 0;
  }

  async clearRegister(register) {
    const { rowCount } = await this.pool.query('DELETE FROM tracker.records WHERE register = $1', [
      register,
    ]);
    return rowCount;
  }

  async logActivity(entry) {
    await this.pool.query(
      `INSERT INTO tracker.activity (id, at, actor, action, register, record_id, summary, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.id,
        entry.at,
        entry.actor,
        entry.action,
        entry.register,
        entry.recordId,
        entry.summary,
        JSON.stringify(entry.detail ?? {}),
      ],
    );
  }

  async recentActivity(limit = 50) {
    const { rows } = await this.pool.query(
      'SELECT * FROM tracker.activity ORDER BY at DESC LIMIT $1',
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      at: asIsoString(r.at),
      actor: r.actor,
      action: r.action,
      register: r.register,
      recordId: r.record_id,
      summary: r.summary,
      detail: r.detail ?? {},
    }));
  }
}

// ---------------------------------------------------------------------------
// JSON-file backend
// ---------------------------------------------------------------------------

class FileStore {
  constructor(file) {
    this.file = file;
    this.kind = 'file';
    this.state = { records: [], activity: [] };
    // Writes are serialised through this promise chain. Two imports landing at once
    // would otherwise each read, then each write, and the second would erase the first.
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        records: Array.isArray(parsed.records) ? parsed.records : [],
        activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#flush();
    }
  }

  #persist() {
    this.writeQueue = this.writeQueue.then(
      () => this.#flush(),
      () => this.#flush(),
    );
    return this.writeQueue;
  }

  async #flush() {
    // Written to a sibling then renamed: a crash mid-write leaves the previous file
    // intact rather than a truncated one that fails to parse on next boot.
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(temp, this.file);
  }

  async list(query = {}) {
    return applyQuery(this.state.records.map(toApi), query);
  }

  async all(register = null) {
    const rows = register ? this.state.records.filter((r) => r.register === register) : this.state.records;
    return rows.map(toApi);
  }

  async get(id) {
    const found = this.state.records.find((r) => r.id === id);
    return found ? toApi(found) : null;
  }

  async insertMany(rows) {
    this.state.records.push(...rows);
    await this.#persist();
    return rows.length;
  }

  async updateRow(row) {
    const index = this.state.records.findIndex((r) => r.id === row.id);
    if (index === -1) return null;
    this.state.records[index] = row;
    await this.#persist();
    return toApi(row);
  }

  async remove(id) {
    const index = this.state.records.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.state.records.splice(index, 1);
    await this.#persist();
    return true;
  }

  async clearRegister(register) {
    const before = this.state.records.length;
    this.state.records = this.state.records.filter((r) => r.register !== register);
    await this.#persist();
    return before - this.state.records.length;
  }

  async logActivity(entry) {
    this.state.activity.unshift(entry);
    // Bounded: the activity feed is a recent-changes list, not an audit archive.
    this.state.activity = this.state.activity.slice(0, 500);
    await this.#persist();
  }

  async recentActivity(limit = 50) {
    return this.state.activity.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------

export async function createStore(env = process.env) {
  if (env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      // Managed Postgres (Render, Neon, Supabase) terminates TLS with a certificate
      // the container's trust store does not carry. Opt out only when the operator
      // asks for it, so a self-hosted deployment keeps full verification.
      ssl:
        env.DATABASE_SSL === 'disable'
          ? false
          : env.DATABASE_SSL === 'no-verify'
            ? { rejectUnauthorized: false }
            : undefined,
      max: 5,
    });
    const store = new PostgresStore(pool);
    await store.init();
    return store;
  }

  const file = resolve(env.TRACKER_DATA_FILE || 'data/tracker.json');
  const store = new FileStore(file);
  await store.init();
  return store;
}

export { toRow, toApi, applyQuery };
