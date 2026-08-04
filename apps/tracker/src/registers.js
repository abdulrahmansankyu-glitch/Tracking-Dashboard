/**
 * The seven registers the engineering team tracks, and how each one maps onto a
 * single shared shape.
 *
 * Every register keeps its own columns — an IWS row genuinely is not a PDM row, and
 * flattening them into one generic "task" would lose the Notification/WO numbers,
 * the calibration dates and the vibration-analysis findings that make each sheet
 * useful. So each register declares its own `fields`, stored verbatim.
 *
 * What makes a dashboard possible is `roles`: a per-register statement of which of
 * its own columns answers each cross-cutting question — what is this called, who
 * owns it, when is it due, how urgent is it. Derivation reads only `roles`, so
 * adding an eighth register is a data change here and nothing else anywhere.
 */

/** Normalised priority ladder. Lower `rank` is more urgent. */
export const PRIORITIES = [
  { value: 'Critical', rank: 1 },
  { value: 'High', rank: 2 },
  { value: 'Medium', rank: 3 },
  { value: 'Low', rank: 4 },
  { value: 'Planned', rank: 5 },
];

export const PRIORITY_VALUES = PRIORITIES.map((p) => p.value);

export const STATUSES = [
  'Not Started',
  'In Progress',
  'On Hold',
  'Completed',
  'Cancelled',
  'Archived',
];

/** Statuses that mean "no longer on anybody's plate". */
export const CLOSED_STATUSES = new Set(['Completed', 'Cancelled', 'Archived']);

/**
 * Free text from the sheets → the normalised ladder.
 *
 * The sheets use three different vocabularies: IWS uses P1–P5, CTS uses
 * High/Medium/Low, and PDM uses condition-monitoring severities (Alarm, Suspect,
 * Orange). All three are graded urgency, so all three map onto one ladder rather
 * than becoming three incomparable columns nobody can chart together.
 */
const PRIORITY_ALIASES = new Map(
  Object.entries({
    p1: 'Critical',
    p2: 'High',
    p3: 'Medium',
    p4: 'Low',
    p5: 'Planned',
    critical: 'Critical',
    urgent: 'Critical',
    emergency: 'Critical',
    danger: 'Critical',
    red: 'Critical',
    alarm: 'High',
    high: 'High',
    orange: 'Medium',
    suspect: 'Medium',
    medium: 'Medium',
    med: 'Medium',
    moderate: 'Medium',
    normal: 'Low',
    low: 'Low',
    green: 'Low',
    minor: 'Low',
    planned: 'Planned',
    routine: 'Planned',
  }),
);

/** Free text from the sheets → the normalised status list. */
const STATUS_ALIASES = new Map(
  Object.entries({
    completed: 'Completed',
    complete: 'Completed',
    done: 'Completed',
    closed: 'Completed',
    close: 'Completed',
    finished: 'Completed',
    ongoing: 'In Progress',
    inprogress: 'In Progress',
    progress: 'In Progress',
    started: 'In Progress',
    open: 'In Progress',
    wip: 'In Progress',
    notstarted: 'Not Started',
    new: 'Not Started',
    pending: 'Not Started',
    onhold: 'On Hold',
    hold: 'On Hold',
    waiting: 'On Hold',
    deferred: 'On Hold',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
    dropped: 'Cancelled',
    archived: 'Archived',
    archive: 'Archived',
    // "Overdue" describes the due date, not the work. Treat it as still in progress
    // and let the computed due-date state say it is late — otherwise a row goes on
    // reading "Overdue" forever after somebody finally does the job.
    overdue: 'In Progress',
    delayed: 'In Progress',
    late: 'In Progress',
  }),
);

/** Strip case, spaces and punctuation so "Action By " matches "action_by". */
export function normaliseKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function normalisePriority(value) {
  const key = normaliseKey(value);
  if (!key) return null;
  return PRIORITY_ALIASES.get(key) ?? null;
}

export function normaliseStatus(value) {
  const key = normaliseKey(value);
  if (!key) return null;
  return STATUS_ALIASES.get(key) ?? null;
}

const text = (key, label, aliases = []) => ({ key, label, type: 'text', aliases });
const longtext = (key, label, aliases = []) => ({ key, label, type: 'longtext', aliases });
const date = (key, label, aliases = []) => ({ key, label, type: 'date', aliases });
const number = (key, label, aliases = []) => ({ key, label, type: 'number', aliases });
const select = (key, label, options, aliases = []) => ({
  key,
  label,
  type: 'select',
  options,
  aliases,
});

export const REGISTERS = [
  {
    id: 'action-notice',
    name: 'Action Notice',
    short: 'AN',
    description: 'Engineering action notices raised on plant equipment.',
    // Both uploaded workbooks title this sheet "Sheet1", so name-matching alone
    // cannot identify it. Header matching (below) is what actually resolves it.
    sheetAliases: ['action notice', 'action notice tracking', 'an', 'sheet1'],
    fields: [
      text('documentNo', 'Document No.', ['document no', 'doc no', 'documentnumber']),
      date('issuedDate', 'Date', ['date', 'date issued', 'raised on']),
      longtext('description', 'Description', ['description', 'work description']),
      text('location', 'Location / Tag', ['location  tag', 'location', 'tag', 'equipment tag']),
      text('initiator', 'Initiator', ['initiator', 'raised by', 'initiated by']),
      text('etc', 'ETC', ['etc', 'estimated completion', 'target']),
      text('actionBy', 'Action By', ['action by', 'actionby', 'responsible', 'owner']),
      select('status', 'Status', STATUSES, ['status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      longtext('remarks', 'Remarks', ['remarks', 'comment', 'notes']),
    ],
    roles: {
      ref: 'documentNo',
      title: 'description',
      // ETC is this sheet's commitment date — and it is sometimes a date and
      // sometimes a phrase ("Next Shutdown"). `deriveRecord` keeps whichever it is.
      due: 'etc',
      issued: 'issuedDate',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      initiator: 'initiator',
      location: 'location',
    },
  },

  {
    id: 'iws',
    name: 'IWS',
    short: 'IWS',
    description: 'Inspection work scopes raised against plant units.',
    sheetAliases: ['iws', 'iws track', 'iws tracking'],
    fields: [
      text('iwsNumber', 'IWS Number', ['iws number', 'iws no', 'iwsnumber']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      text('area', 'Area', ['area']),
      text('unit', 'Unit', ['unit']),
      text('discipline', 'Discipline', ['discipline', 'trade']),
      longtext('description', 'Description', ['description', 'scope']),
      date('issuedDate', 'Date Issued', ['date issued', 'issued date', 'date']),
      date('targetDate', 'Target Date', ['target date', 'due date', 'target']),
      text('counter', 'Counter', ['counter']),
      text('notificationNo', 'Notification No.', ['notification no', 'notification']),
      text('woNo', 'WO. No.', ['wo no', 'work order', 'wo number', 'wo']),
      text('prPoNo', 'PR & PO No', ['pr  po no', 'pr po no', 'pr po', 'prpo']),
      number('itemsCount', 'Items Count', ['items count', 'total items']),
      number('itemsCompleted', 'Items Comp.', ['items comp', 'items completed']),
      number('progress', 'Progress', ['progress', 'percent complete', 'completion']),
      text('inspectionType', 'Type Of Inspection', ['type of inspection', 'inspection type']),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner']),
      longtext('updates', 'Updates', ['updates', 'update']),
      select('status', 'Status', STATUSES, ['status']),
      date('closeDate', 'Close Date', ['close date', 'closed on', 'completion date']),
      longtext('remarks', 'Remarks', ['remarks', 'comment', 'notes']),
    ],
    roles: {
      ref: 'iwsNumber',
      title: 'description',
      due: 'targetDate',
      issued: 'issuedDate',
      closed: 'closeDate',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      area: 'area',
      discipline: 'discipline',
      progress: 'progress',
    },
  },

  {
    id: 'pzv',
    name: 'PZV',
    short: 'PZV',
    description: 'Pressure safety valve calibration and overhaul schedule.',
    sheetAliases: ['pzv', 'pzv tracking', 'pzv tracking sheet', 'psv'],
    fields: [
      text('area', 'Area', ['area']),
      text('plantSection', 'Plant Section', ['plant section', 'section', 'unit']),
      longtext('description', 'Description', ['description']),
      text('sortField', 'Sort Field', ['sort field', 'tag', 'valve tag']),
      longtext('maintenanceItem', 'Maintenance Item Text', [
        'maintenance item text',
        'maintenance item',
      ]),
      date('lastCalibration', 'Last Calibration Date', [
        'last calibration date',
        'last calibration',
      ]),
      date('dueDate', 'Due Date', ['due date', 'next calibration', 'next due']),
      date('plannedDate', 'Plan date for callibration', [
        'plan date for callibration',
        'plan date for calibration',
        'planned date',
      ]),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner']),
      select('status', 'Status', STATUSES, ['status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      longtext('remarks', 'Remarks', ['remarks', 'notes']),
    ],
    roles: {
      ref: 'sortField',
      title: 'description',
      due: 'dueDate',
      issued: 'lastCalibration',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      area: 'area',
      location: 'sortField',
    },
  },

  {
    id: 'eis',
    name: 'EIS',
    short: 'EIS',
    description: 'Equipment inspection strategy — vessels and tanks.',
    sheetAliases: ['eis', 'eis tracking', 'eis tracking sheet'],
    fields: [
      text('area', 'Area', ['area']),
      text('equipmentNumber', 'Equipment Number', ['equipment number', 'equipment no', 'tag']),
      longtext('description', 'Description', ['description']),
      text('equipmentType', 'Equipment Type', ['equipment type', 'type']),
      text('strategy', 'Inspection Asset Strategy', [
        'inspection asset strategy',
        'asset strategy',
        'strategy',
      ]),
      date('lastInspection', 'Last Inspection', ['last inspection', 'last inspection date']),
      date('nextInspection', 'Next Inspection', ['next inspection', 'next inspection date']),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner']),
      select('status', 'Status', STATUSES, ['status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      longtext('remarks', 'Remarks', ['remarks', 'notes']),
    ],
    roles: {
      ref: 'equipmentNumber',
      title: 'description',
      due: 'nextInspection',
      issued: 'lastInspection',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      area: 'area',
      location: 'equipmentNumber',
    },
  },

  {
    id: 'routine-inspection',
    name: 'Routine Inspection',
    short: 'RI',
    description: 'Recurring inspection routines by interval and discipline.',
    sheetAliases: ['routine inspection', 'inspection routine', 'routine'],
    fields: [
      text('area', 'Area', ['area']),
      text('discipline', 'Discipline', ['discipline', 'trade']),
      text('interval', 'Interval', ['interval', 'frequency']),
      longtext('activity', 'Inspection Activity', ['inspection activity', 'activity']),
      text('equipments', 'Equipments', ['equipments', 'equipment']),
      text('duration', 'Duration of Inspection', ['duration of inspection', 'duration']),
      text('actionBy', 'Action by', ['action by', 'responsible', 'owner']),
      date('inspectionDate', 'Inspection Date', ['inspection date', 'last inspection']),
      // In the source sheet this column holds month names ("SEP", "JAN") as often as
      // real dates, so it is typed as text and parsed opportunistically.
      text('nextInspection', 'Next Inspec Date', [
        'next inspec date',
        'next inspection date',
        'next inspection',
      ]),
      select('status', 'Status', STATUSES, ['status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      longtext('remarks', 'Remarks', ['remarks', 'notes']),
    ],
    roles: {
      ref: 'equipments',
      title: 'activity',
      due: 'nextInspection',
      issued: 'inspectionDate',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      area: 'area',
      discipline: 'discipline',
    },
  },

  {
    id: 'cts-recommendation',
    name: 'CTS Recommendation',
    short: 'CTS',
    description: 'Recommendations arising from CTS investigation reports.',
    sheetAliases: ['cts recommendation', 'cts recommendations', 'cts'],
    fields: [
      longtext('recommendation', 'Recommendation', ['recommendation']),
      longtext('basis', 'Basis', ['basis', 'rationale']),
      text('actionBy', 'Action by', ['action by', 'responsible', 'owner']),
      longtext('notes', 'Notes', ['notes', 'note']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      select('status', 'Status', STATUSES, ['status']),
      longtext('remarks', 'Remarks', ['remarks']),
      text('etc', 'ETC', ['etc', 'estimated completion', 'target date']),
      text('category', 'Category', ['category']),
      text('reference', 'Refrence', ['refrence', 'reference', 'ref']),
      text('owner', 'Recom Owner', ['recom owner', 'recommendation owner', 'initiator']),
      text('equipment', 'Equipment', ['equipment', 'tag']),
      text('source', 'Source', ['source']),
    ],
    roles: {
      ref: 'reference',
      title: 'recommendation',
      due: 'etc',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      initiator: 'owner',
      location: 'equipment',
    },
  },

  {
    id: 'pdm',
    name: 'PDM',
    short: 'PDM',
    description: 'Predictive maintenance findings — vibration and oil analysis.',
    sheetAliases: ['pdm', 'predictive maintenance', 'pdm tracking'],
    fields: [
      text('technique', 'Technique', ['technique', 'method']),
      text('equipmentTag', 'Equipment Tag', ['equipment tag', 'tag', 'equipment']),
      date('reportDate', 'Report Date', ['report date', 'date']),
      // Severity is this register's urgency vocabulary; it feeds the priority ladder.
      text('severity', 'Severity', ['severity']),
      longtext('finding', 'Finding / Analysis', ['finding  analysis', 'finding', 'analysis']),
      longtext('recommendation', 'Recommendation', ['recommendation']),
      text('progress', 'Progress', ['progress']),
      longtext('maintenanceAction', 'Maintenance Action', ['maintenance action', 'action']),
      select('status', 'Case Status', STATUSES, ['case status', 'status']),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner']),
      date('targetDate', 'Target Date', ['target date', 'due date', 'etc']),
      longtext('remarks', 'Remarks', ['remarks', 'notes']),
    ],
    roles: {
      ref: 'equipmentTag',
      title: 'finding',
      due: 'targetDate',
      issued: 'reportDate',
      // No Priority column in the sheet — severity carries the urgency instead.
      priority: 'severity',
      status: 'status',
      actionBy: 'actionBy',
      location: 'equipmentTag',
    },
  },
];

export const REGISTER_BY_ID = new Map(REGISTERS.map((r) => [r.id, r]));

export function getRegister(id) {
  return REGISTER_BY_ID.get(String(id ?? '').toLowerCase()) ?? null;
}

/**
 * Excel serial dates far outside plant history are a spreadsheet accident, not a
 * date. The uploaded EIS sheet has several 1934/1935 "Next Inspection" values —
 * a five-year addition that wrapped. Admitting them would put permanently
 * overdue rows at the top of every dashboard, so they are kept as raw text and
 * excluded from date maths.
 */
const MIN_PLAUSIBLE_YEAR = 1990;
const MAX_PLAUSIBLE_YEAR = 2100;

/**
 * Coerce a cell to a calendar date, or null when it is a phrase.
 *
 * "Next Shutdown" in an ETC column is real, deliberate information — it means the
 * work is scheduled but not dated. It must survive as text rather than being
 * discarded for failing to parse.
 */
export function toDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return withinRange(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial: days since 1899-12-30 (the epoch that absorbs the 1900 leap bug).
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return withinRange(new Date(ms));
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // dd/mm/yyyy and dd-mm-yyyy, which Excel exports as text more often than not.
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return withinRange(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))));
  }

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return withinRange(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))));
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return withinRange(parsed);
}

function withinRange(dateValue) {
  const year = dateValue.getUTCFullYear();
  if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return null;
  // Normalise to a plain calendar day. A due date has no time of day, and keeping
  // one makes "due today" depend on the reader's timezone.
  return `${year}-${pad(dateValue.getUTCMonth() + 1)}-${pad(dateValue.getUTCDate())}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whole days from today to `iso`; negative when the date has passed. */
export function daysUntil(iso, from = todayIso()) {
  if (!iso) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** The window the team called "near one month or less". */
export const DUE_SOON_DAYS = 30;

export function dueState(dueDate, status) {
  if (CLOSED_STATUSES.has(status)) return 'closed';
  if (!dueDate) return 'undated';
  const days = daysUntil(dueDate);
  if (days === null) return 'undated';
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'due-soon';
  return 'scheduled';
}

/**
 * Fold a register-specific row into the shared shape the dashboard reads.
 *
 * Returns only derived values; `data` is stored untouched alongside so nothing
 * from the original sheet is ever lost to normalisation.
 */
export function deriveRecord(register, data) {
  const roles = register.roles;
  const pick = (role) => {
    const key = roles[role];
    if (!key) return null;
    const value = data?.[key];
    if (value === null || value === undefined) return null;
    const trimmed = typeof value === 'string' ? value.trim() : value;
    return trimmed === '' ? null : trimmed;
  };

  const dueRaw = pick('due');
  const dueDate = toDateOnly(dueRaw);

  const status = normaliseStatus(pick('status')) ?? 'Not Started';
  const priority = normalisePriority(pick('priority')) ?? 'Medium';

  const title = pick('title');
  const ref = pick('ref');

  return {
    ref: ref === null ? null : String(ref),
    title: title === null ? null : String(title),
    // The phrase behind an unparseable due date ("Next Shutdown", "SEP"), kept so
    // the table can show why a row has no date instead of showing an empty cell.
    dueText: dueDate ? null : dueRaw === null ? null : String(dueRaw),
    dueDate,
    issuedDate: toDateOnly(pick('issued')),
    closedDate: toDateOnly(pick('closed')),
    priority,
    priorityRaw: pick('priority') === null ? null : String(pick('priority')),
    status,
    statusRaw: pick('status') === null ? null : String(pick('status')),
    actionBy: pick('actionBy') === null ? null : String(pick('actionBy')).trim(),
    initiator: pick('initiator') === null ? null : String(pick('initiator')).trim(),
    area: pick('area') === null ? null : String(pick('area')).trim(),
    discipline: pick('discipline') === null ? null : String(pick('discipline')).trim(),
    location: pick('location') === null ? null : String(pick('location')).trim(),
  };
}

/** Serialisable definitions for the browser, so the UI is never a second source of truth. */
export function registerCatalogue() {
  return REGISTERS.map((r) => ({
    id: r.id,
    name: r.name,
    short: r.short,
    description: r.description,
    fields: r.fields,
    roles: r.roles,
  }));
}
