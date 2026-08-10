/*
 * Engineering Activity Tracker — browser app.
 *
 * Plain ES modules with no build step and no framework, so the app that runs is
 * the file in the repository. Whoever maintains this after us can open app.js,
 * read it, change it, and reload — no toolchain to install first.
 *
 * The register definitions come from the server (`/api/config`), never from a
 * copy here: the columns, their labels and their types have exactly one source of
 * truth, and adding a register needs no change to this file.
 */

// ---------------------------------------------------------------- helpers --

/** Minimal hyperscript. `h('div', {class: 'x'}, 'text', child)` */
function h(tag, props = null, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
    else el.setAttribute(key, value);
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return el;
}

const $ = (selector, scope = document) => scope.querySelector(selector);

const TODAY = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function daysUntil(iso) {
  if (!iso) return null;
  const a = Date.parse(`${TODAY()}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

const CLOSED = new Set(['Completed', 'Cancelled', 'Archived']);

function dueState(dueDate, status) {
  if (CLOSED.has(status)) return 'closed';
  if (!dueDate) return 'undated';
  const days = daysUntil(dueDate);
  if (days === null) return 'undated';
  if (days < 0) return 'overdue';
  if (days <= (state.config?.dueSoonDays ?? 30)) return 'due-soon';
  return 'scheduled';
}

function dueLabel(record) {
  const st = dueState(record.dueDate, record.status);
  if (st === 'closed') return 'Closed';
  if (st === 'undated') return record.dueText ? record.dueText : 'No date';
  const days = daysUntil(record.dueDate);
  if (days < 0) return `${Math.abs(days)}d late`;
  if (days === 0) return 'Today';
  return `in ${days}d`;
}

const fmtDate = (iso) => (iso ? iso : '—');

function fmtWhen(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 10080) return `${Math.round(mins / 1440)}d ago`;
  return then.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ state --

const state = {
  config: null,
  view: 'dashboard',
  registerId: null,
  user: localStorage.getItem('tracker.user') ?? '',
  accessCode: localStorage.getItem('tracker.code') ?? '',
  theme: localStorage.getItem('tracker.theme') ?? 'auto',
  gate: null, // 'code' | 'name' | null
  dashboard: null,
  list: null,
  filterOptions: { actionBy: [], initiator: [], area: [] },
  query: {},
  drawer: null, // { record, registerId, isNew }
  importState: null,
  imports: null,
  importsScope: null,
  activity: null,
  busy: false,
  error: null,
  toast: null,
};

const defaultQuery = () => ({
  search: '',
  priority: '',
  status: '',
  actionBy: '',
  due: '',
  open: true,
  sort: 'dueDate',
  direction: 'asc',
  page: 1,
  pageSize: 50,
});

// -------------------------------------------------------------------- api --

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (state.user) headers['x-user-name'] = state.user;
  if (state.accessCode) headers['x-access-code'] = state.accessCode;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.json);
    options.method = options.method ?? 'POST';
  }

  // The standalone single-file build has no server behind it. It installs a local
  // handler that answers these same paths out of browser storage and returns real
  // `Response` objects, so everything below — and the whole UI — runs unchanged
  // against either transport.
  const response = globalThis.__trackerLocalApi
    ? await globalThis.__trackerLocalApi(path, { ...options, headers })
    : await fetch(path, { ...options, headers });

  // Checking a code is the one place a 401 is an answer rather than a problem —
  // sending the user back to the gate they are already standing at would replace
  // "that code is not right" with a vaguer message.
  if (response.status === 401 && path !== '/api/session') {
    state.accessCode = '';
    localStorage.removeItem('tracker.code');
    state.gate = 'code';
    render();
    throw new Error('Team access code required.');
  }

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  if (!response.ok) {
    const body = isJson ? await response.json().catch(() => ({})) : {};
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }

  return isJson ? response.json() : response;
}

/** Downloads need the auth header, so they go through fetch rather than a bare link. */
async function download(path) {
  try {
    toast('Preparing the file…');
    const response = await api(path);
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const name = disposition.match(/filename="(.+?)"/)?.[1] ?? 'export.xlsx';

    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast(`Downloaded ${name}`);
  } catch (error) {
    toast(error.message);
  }
}

let toastTimer = null;
function toast(message) {
  state.toast = message;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, 3600);
}

// ------------------------------------------------------------------ chrome --

const registerById = (id) => state.config?.registers.find((r) => r.id === id) ?? null;

const PRIORITY_CLASS = {
  Critical: 'p-critical',
  High: 'p-high',
  Medium: 'p-medium',
  Low: 'p-low',
  Planned: 'p-planned',
};

const priorityChip = (priority) =>
  h('span', { class: `chip ${PRIORITY_CLASS[priority] ?? 'p-medium'}` }, priority ?? 'Medium');

const dueChip = (record) =>
  h('span', { class: `chip s-${dueState(record.dueDate, record.status)}` }, dueLabel(record));

/**
 * One table cell, rendered according to the job that column does.
 *
 * Values come from the record's own stored columns, except priority and status,
 * which come from the derived values — the sheets spell those a dozen ways ("P1",
 * "Alarm", "On going", "Close") and a table that prints each spelling verbatim
 * cannot be scanned. The date column carries its lateness chip so a register that
 * shows no explicit status still shows what is late.
 */
function cell(register, record, field) {
  const roles = register.roles;
  const raw = record.data?.[field.key];

  if (field.key === roles.priority) return h('td', null, priorityChip(record.priority));

  if (field.key === roles.status) {
    return h('td', null, record.status, raw && record.status !== raw ? h('div', { class: 'hint' }, raw) : null);
  }

  if (field.key === roles.due) {
    return h('td', null, dueChip(record), record.dueDate && h('div', { class: 'hint' }, record.dueDate));
  }

  if (raw === undefined || raw === null || raw === '') return h('td', { class: 'muted' }, '—');

  if (field.type === 'longtext') {
    return h('td', null, h('span', { class: 'cell-title', title: String(raw) }, String(raw)));
  }

  if (field.type === 'number') return h('td', { class: 'num' }, String(raw));

  if (field.key === roles.ref) return h('td', null, h('span', { class: 'cell-ref' }, String(raw)));

  return h('td', null, String(raw));
}

/**
 * A horizontal bar. `segments` are drawn in order with a 2px surface gap, and the
 * total is always printed at the end so the value never depends on reading colour.
 */
function barRow(label, segments, max, note = null) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const scale = max > 0 ? max : 1;

  return h(
    'div',
    { class: 'bar-row' },
    h('div', { class: 'b-label', title: label }, label),
    h(
      'div',
      { class: 'bar-track' },
      segments
        .filter((s) => s.value > 0)
        .map((s) =>
          h('div', {
            class: 'bar-fill',
            style: `width: ${(s.value / scale) * 100}%; background: ${s.color}`,
            title: `${s.label}: ${s.value}`,
          }),
        ),
    ),
    h('div', { class: 'b-value' }, note ?? total),
  );
}

/**
 * A ring showing how one register's work divides up.
 *
 * Four segments that sum to the register's total, so the ring is genuinely
 * part-to-whole rather than a pie of unrelated numbers. Every segment is also
 * printed as a labelled figure beside it — the ring shows the shape at a glance,
 * the numbers carry the meaning, and nothing depends on telling two colours apart.
 */
function donut(segments, total, size = 104) {
  const stroke = 15;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const fraction = total > 0 ? s.value / total : 0;
      // A 1.5px gap between arcs keeps neighbouring segments from reading as one.
      const length = Math.max(0, fraction * circumference - 1.5);
      const circle = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}"
        fill="none" stroke="${s.color}" stroke-width="${stroke}"
        stroke-dasharray="${length} ${circumference - length}"
        stroke-dashoffset="${-offset}" stroke-linecap="butt"
        transform="rotate(-90 ${size / 2} ${size / 2})"><title>${s.label}: ${s.value}</title></circle>`;
      offset += fraction * circumference;
      return circle;
    })
    .join('');

  const ring = h('div', {
    class: 'donut',
    html: `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
      aria-label="${segments.map((s) => `${s.label} ${s.value}`).join(', ')}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none"
        stroke="var(--plane)" stroke-width="${stroke}"/>
      ${arcs}
    </svg>`,
  });

  return h(
    'div',
    { class: 'donut-wrap' },
    ring,
    h('div', { class: 'donut-centre' }, h('strong', null, total), h('span', null, 'total')),
  );
}

const legend = (items) =>
  h(
    'div',
    { class: 'legend' },
    items.map((item) =>
      h('span', null, h('i', { style: `background: ${item.color}` }), item.label),
    ),
  );

const COLOR = {
  overdue: 'var(--critical)',
  dueSoon: 'var(--warning)',
  later: 'var(--accent)',
  bin: ['var(--critical)', 'var(--bin-1)', 'var(--bin-2)', 'var(--bin-3)', 'var(--bin-4)', 'var(--line)'],
  priority: {
    Critical: 'var(--critical)',
    High: 'var(--serious)',
    Medium: 'var(--warning)',
    Low: 'var(--accent)',
    Planned: 'var(--line)',
  },
};

// ----------------------------------------------------------------- loaders --

async function loadDashboard() {
  state.busy = true;
  render();
  try {
    state.dashboard = await api('/api/dashboard');
    state.error = null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    render();
  }
}

async function loadList() {
  state.busy = true;
  render();
  try {
    const params = new URLSearchParams();
    params.set('register', state.registerId);
    for (const [key, value] of Object.entries(state.query)) {
      if (value === '' || value === false || value === null) continue;
      params.set(key, String(value));
    }
    const [list, filters] = await Promise.all([
      api(`/api/records?${params}`),
      api(`/api/filters?register=${state.registerId}`),
    ]);
    state.list = list;
    state.filterOptions = filters;
    state.error = null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    render();
  }
}

function go(view, registerId = null) {
  state.view = view;
  state.registerId = registerId;
  state.drawer = null;

  // Coming back to Import after a finished run means starting another one, so the
  // last run's summary steps aside. A half-finished run is left alone — someone who
  // clicked away mid-confirm should find their sheet choices where they left them.
  if (view === 'import' && ['done', 'error'].includes(state.importState?.stage)) {
    state.importState = null;
  }

  if (view === 'dashboard') loadDashboard();
  else if (view === 'register') {
    state.query = defaultQuery();
    state.list = null;
    loadList();
  } else if (view === 'activity') {
    api('/api/activity')
      .then((data) => {
        state.activity = data.activity;
        render();
      })
      .catch((error) => toast(error.message));
    render();
  } else render();
}

// ------------------------------------------------------------------- gates --

function renderGate() {
  if (state.gate === 'code') {
    let value = '';
    return h(
      'div',
      { class: 'scrim modal-centre' },
      h(
        'form',
        {
          class: 'modal',
          onsubmit: async (event) => {
            event.preventDefault();
            try {
              await api('/api/session', { json: { accessCode: value } });
              state.accessCode = value;
              localStorage.setItem('tracker.code', value);
              state.gate = state.user ? null : 'name';
              if (!state.gate) go('dashboard');
              else render();
            } catch (error) {
              state.error = error.message;
              render();
            }
          },
        },
        h('h2', null, 'Team access code'),
        h(
          'p',
          { class: 'hint', style: 'margin: 8px 0 16px' },
          'This tracker is shared with your team. Enter the code your supervisor gave you.',
        ),
        state.error && h('div', { class: 'banner error', style: 'margin-bottom: 12px' }, state.error),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Access code'),
          h('input', {
            type: 'password',
            id: 'gate-code',
            autofocus: 'autofocus',
            oninput: (e) => {
              value = e.target.value;
            },
          }),
        ),
        h(
          'div',
          { style: 'margin-top: 16px; display: flex; justify-content: flex-end' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Continue'),
        ),
      ),
    );
  }

  let value = state.user;
  return h(
    'div',
    { class: 'scrim modal-centre' },
    h(
      'form',
      {
        class: 'modal',
        onsubmit: (event) => {
          event.preventDefault();
          const name = value.trim();
          if (!name) return;
          state.user = name;
          localStorage.setItem('tracker.user', name);
          state.gate = null;
          go('dashboard');
        },
      },
      h('h2', null, 'Who are you?'),
      h(
        'p',
        { class: 'hint', style: 'margin: 8px 0 16px' },
        'Your name is recorded against every entry you add or change, so the team can see who updated what. No password needed.',
      ),
      h(
        'label',
        { class: 'field' },
        h('span', null, 'Your name'),
        h('input', {
          type: 'text',
          id: 'gate-name',
          value: state.user,
          placeholder: 'e.g. Abdul Rahman',
          autofocus: 'autofocus',
          oninput: (e) => {
            value = e.target.value;
          },
        }),
      ),
      h(
        'div',
        { style: 'margin-top: 16px; display: flex; justify-content: flex-end' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Start'),
      ),
    ),
  );
}

// ----------------------------------------------------------------- sidebar --

function renderSidebar() {
  const counts = new Map(
    (state.dashboard?.byRegister ?? []).map((r) => [r.id, r]),
  );

  return h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'brand-mark' }, 'EA'),
      h(
        'div',
        { class: 'brand-text' },
        h('strong', null, 'Activity Tracker'),
        h('span', null, 'Engineering — SHP / DCU'),
      ),
    ),

    h(
      'button',
      {
        class: 'nav-item',
        'aria-current': String(state.view === 'dashboard'),
        onclick: () => go('dashboard'),
      },
      h('span', { class: 'short' }, '▦'),
      h('span', { class: 'grow' }, 'Dashboard'),
    ),

    h('div', { class: 'nav-label' }, 'Registers'),
    (state.config?.registers ?? []).map((register) => {
      const stat = counts.get(register.id);
      const late = stat?.overdue ?? 0;
      return h(
        'button',
        {
          class: 'nav-item',
          'aria-current': String(state.view === 'register' && state.registerId === register.id),
          onclick: () => go('register', register.id),
          title: register.description,
        },
        h('span', { class: 'short' }, register.short),
        h('span', { class: 'grow' }, register.name),
        h(
          'span',
          { class: `nav-count${late ? ' alert' : ''}`, title: late ? `${late} overdue` : 'open items' },
          late ? `${late}!` : (stat?.open ?? ''),
        ),
      );
    }),

    h('div', { class: 'nav-label' }, 'Data'),
    h(
      'button',
      {
        class: 'nav-item',
        'aria-current': String(state.view === 'import'),
        onclick: () => go('import'),
      },
      h('span', { class: 'short' }, '↑'),
      h('span', { class: 'grow' }, 'Import Excel'),
    ),
    h(
      'button',
      { class: 'nav-item', onclick: () => download('/api/export') },
      h('span', { class: 'short' }, '↓'),
      h('span', { class: 'grow' }, 'Export all'),
    ),
    h(
      'button',
      {
        class: 'nav-item',
        'aria-current': String(state.view === 'activity'),
        onclick: () => go('activity'),
      },
      h('span', { class: 'short' }, '⟳'),
      h('span', { class: 'grow' }, 'Recent changes'),
    ),

    h(
      'div',
      { class: 'sidebar-foot' },
      h('div', null, `Signed in as ${state.user || '—'}`),
      h(
        'button',
        {
          class: 'btn ghost sm',
          style: 'margin-top: 6px; padding-left: 0',
          onclick: () => {
            state.gate = 'name';
            render();
          },
        },
        'Change name',
      ),
    ),
  );
}

// --------------------------------------------------------------- dashboard --

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading…');

  const t = data.totals;

  return h(
    'div',
    { class: 'content' },

    h(
      'div',
      { class: 'kpis' },
      kpi('Total Jobs', t.all, 'across all seven registers'),
      kpi('Open', t.open, 'still to do'),
      kpi('Closed', t.closed, 'completed, cancelled or archived'),
      kpi(`Due in ${state.config.dueSoonDays} days`, t.dueSoon, 'the month ahead'),
      kpi('Completed', t.completed, 'finished, not cancelled'),
      kpi('Overdue', t.overdue, 'past their due date', t.overdue > 0 ? 'is-critical' : null),
    ),

    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Each register at a glance'),
        h('span', { class: 'hint' }, 'click a register to open it'),
      ),
      legend([
        { label: 'Overdue', color: COLOR.overdue },
        { label: `Due within ${state.config.dueSoonDays} days`, color: COLOR.dueSoon },
        { label: 'Open', color: COLOR.later },
        { label: 'Closed', color: 'var(--good)' },
      ]),
      h(
        'div',
        { class: 'register-grid' },
        data.byRegister.map((row) =>
          h(
            'button',
            { class: 'register-card', onclick: () => go('register', row.id) },
            h('h3', null, row.name),
            donut(
              [
                { value: row.overdue, color: COLOR.overdue, label: 'Overdue' },
                { value: row.dueSoon, color: COLOR.dueSoon, label: 'Due soon' },
                { value: row.later, color: COLOR.later, label: 'Open' },
                { value: row.closed, color: 'var(--good)', label: 'Closed' },
              ],
              row.total,
            ),
            h(
              'dl',
              { class: 'register-figures' },
              figure('Open', row.open),
              figure('Overdue', row.overdue, row.overdue ? 'is-critical' : null),
              figure(`Due ≤${state.config.dueSoonDays}d`, row.dueSoon, row.dueSoon ? 'is-warning' : null),
              figure('Closed', row.closed),
            ),
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Needs attention'),
        h('span', { class: 'hint' }, `overdue and due within ${state.config.dueSoonDays} days`),
      ),
      data.attention.length
        ? h(
            'div',
            { class: 'table-wrap', style: 'border: 0' },
            h(
              'table',
              null,
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, 'Register'),
                  h('th', null, 'Ref'),
                  h('th', null, 'Description'),
                  h('th', null, 'Priority'),
                  h('th', null, 'Due'),
                  h('th', null, 'Action by'),
                  h('th', null, 'Initiator'),
                ),
              ),
              h(
                'tbody',
                null,
                data.attention.map((row) =>
                  h(
                    'tr',
                    { class: 'clickable', onclick: () => openRecord(row.id, row.register) },
                    h('td', { class: 'muted' }, registerById(row.register)?.short ?? row.register),
                    h('td', null, h('span', { class: 'cell-ref' }, row.ref ?? '—')),
                    h('td', null, h('span', { class: 'cell-title', title: row.title ?? '' }, row.title ?? '—')),
                    h('td', null, priorityChip(row.priority)),
                    h(
                      'td',
                      null,
                      h('span', { class: `chip s-${row.days < 0 ? 'overdue' : 'due-soon'}` }, row.days < 0 ? `${Math.abs(row.days)}d late` : `in ${row.days}d`),
                      h('div', { class: 'hint' }, row.dueDate),
                    ),
                    h('td', null, row.actionBy ?? h('span', { class: 'muted' }, 'Unassigned')),
                    h('td', { class: 'muted' }, row.initiator ?? '—'),
                  ),
                ),
              ),
            ),
          )
        : h('div', { class: 'empty' }, 'Nothing overdue or due in the next month. '),
    ),

    data.activity?.length &&
      h(
        'section',
        { class: 'card' },
        h('header', null, h('h2', null, 'Recent changes')),
        h('div', { class: 'activity-list' }, data.activity.slice(0, 8).map(activityItem)),
      ),
  );
}

function kpi(label, value, note, tone = null) {
  return h(
    'div',
    { class: `kpi ${tone ?? ''}` },
    h('div', { class: 'k-label' }, label),
    h('div', { class: 'k-value' }, value),
    h('div', { class: 'k-note' }, note),
  );
}

const figure = (label, value, tone = null) =>
  h(
    'div',
    { class: `figure ${tone ?? ''}` },
    h('dt', null, label),
    h('dd', null, value),
  );

const activityItem = (entry) =>
  h(
    'div',
    { class: 'activity-item' },
    h('span', { class: 'who' }, entry.actor ?? 'Someone'),
    h('span', null, entry.summary ?? entry.action),
    h('span', { class: 'when' }, fmtWhen(entry.at)),
  );

// ---------------------------------------------------------------- register --

let searchTimer = null;

function renderRegister() {
  const register = registerById(state.registerId);
  if (!register) return h('div', { class: 'empty' }, 'Unknown register.');

  const list = state.list;
  const q = state.query;

  const byKey = new Map(register.fields.map((f) => [f.key, f]));
  const columns = (register.tableColumns ?? []).map((key) => byKey.get(key)).filter(Boolean);

  const setQuery = (patch, reload = true) => {
    Object.assign(state.query, patch);
    if (!('page' in patch)) state.query.page = 1;
    if (reload) loadList();
    else render();
  };

  /**
   * Which of this register's own columns the list can sort by.
   *
   * Sorting runs on the derived values, so only the columns filling a role have a
   * sort key. The rest are shown but not sortable — a header that looks clickable
   * and then does nothing is worse than one that plainly is not.
   */
  const roles = register.roles;
  const sortKeyFor = (fieldKey) =>
    ({
      [roles.ref]: 'ref',
      [roles.title]: 'title',
      [roles.due]: 'dueDate',
      [roles.priority]: 'priority',
      [roles.status]: 'status',
      [roles.actionBy]: 'actionBy',
      [roles.initiator]: 'initiator',
      [roles.area]: 'area',
    })[fieldKey] ?? null;

  const sortHeader = (label, key, extra = {}) =>
    key
      ? h(
          'th',
          {
            class: `sortable ${extra.class ?? ''}`,
            tabindex: '0',
            onclick: () =>
              setQuery({
                sort: key,
                direction: q.sort === key && q.direction === 'asc' ? 'desc' : 'asc',
              }),
          },
          `${label}${q.sort === key ? (q.direction === 'asc' ? ' ↑' : ' ↓') : ''}`,
        )
      : h('th', { class: extra.class ?? '' }, label);

  const select = (label, key, options, allLabel = 'All') =>
    h(
      'label',
      { class: 'field' },
      h('span', null, label),
      h(
        'select',
        { value: q[key] ?? '', onchange: (e) => setQuery({ [key]: e.target.value }) },
        h('option', { value: '' }, allLabel),
        options.map((option) =>
          h(
            'option',
            { value: option.value ?? option, selected: (q[key] ?? '') === (option.value ?? option) },
            option.label ?? option,
          ),
        ),
      ),
    );

  return h(
    'div',
    { class: 'content' },

    h(
      'div',
      { class: 'toolbar' },
      h(
        'label',
        { class: 'field grow' },
        h('span', null, 'Search'),
        h('input', {
          type: 'search',
          id: 'register-search',
          value: q.search,
          placeholder: 'Reference, description, tag, person…',
          oninput: (e) => {
            state.query.search = e.target.value;
            state.query.page = 1;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(loadList, 280);
          },
        }),
      ),
      // Area offers both plants whether or not this register has rows for them
      // yet, so filtering to DCU is possible the moment the first DCU row lands.
      byKey.has('area') &&
        select(
          'Area',
          'area',
          [...new Set([...(state.config.areas ?? []), ...state.filterOptions.area])],
          'All areas',
        ),
      select('Priority', 'priority', state.config.priorities),
      select('Status', 'status', state.config.statuses),
      select('Action by', 'actionBy', state.filterOptions.actionBy, 'Anyone'),
      select(
        'Due',
        'due',
        [
          { value: 'overdue', label: 'Overdue' },
          { value: 'due-soon', label: `Next ${state.config.dueSoonDays} days` },
          { value: 'dated', label: 'Has a date' },
          { value: 'undated', label: 'No date set' },
        ],
        'Any time',
      ),
      h(
        'label',
        { class: 'switch', style: 'padding-bottom: 8px' },
        h('input', {
          type: 'checkbox',
          checked: q.open,
          onchange: (e) => setQuery({ open: e.target.checked }),
        }),
        'Open only',
      ),
    ),

    h(
      'div',
      { class: 'toolbar' },
      h(
        'button',
        { class: 'btn primary', onclick: () => openNew(register.id) },
        '+ Add entry',
      ),
      h('button', { class: 'btn', onclick: () => go('import') }, 'Import from Excel'),
      h(
        'button',
        { class: 'btn', onclick: () => download(`/api/export?register=${register.id}`) },
        'Export this register',
      ),
      h(
        'button',
        { class: 'btn ghost', onclick: () => download(`/api/template?register=${register.id}`) },
        'Blank template',
      ),
      h('div', { class: 'spacer' }),
      list &&
        h(
          'div',
          { class: 'pager' },
          `${list.total} ${list.total === 1 ? 'entry' : 'entries'}`,
          list.pageCount > 1 &&
            h(
              'button',
              { class: 'btn sm', disabled: list.page <= 1, onclick: () => setQuery({ page: list.page - 1 }) },
              '‹ Prev',
            ),
          list.pageCount > 1 && `Page ${list.page} of ${list.pageCount}`,
          list.pageCount > 1 &&
            h(
              'button',
              {
                class: 'btn sm',
                disabled: list.page >= list.pageCount,
                onclick: () => setQuery({ page: list.page + 1 }),
              },
              'Next ›',
            ),
        ),
    ),

    !list
      ? h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading…')
      : list.rows.length === 0
        ? h(
            'div',
            { class: 'card empty' },
            h('p', null, 'Nothing here yet.'),
            h(
              'p',
              { class: 'hint' },
              'Add an entry by hand, or import the sheet from your Excel file.',
            ),
          )
        : h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              null,
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  // The sheets all open with a row number and the team reads by it,
                  // so the position is shown — but computed from the current page
                  // rather than stored, because a stored serial is wrong the moment
                  // anything is sorted, filtered or inserted.
                  h('th', { class: 'num' }, '#'),
                  columns.map((field) =>
                    sortHeader(field.label, sortKeyFor(field.key), {
                      class: field.type === 'number' ? 'num' : '',
                    }),
                  ),
                  sortHeader('Updated', 'updatedAt'),
                ),
              ),
              h(
                'tbody',
                null,
                list.rows.map((record, i) =>
                  h(
                    'tr',
                    { class: 'clickable', tabindex: '0', onclick: () => openRecord(record.id, record.register) },
                    h('td', { class: 'num muted' }, (list.page - 1) * list.pageSize + i + 1),
                    columns.map((field) => cell(register, record, field)),
                    h('td', { class: 'muted' }, fmtWhen(record.updatedAt)),
                  ),
                ),
              ),
            ),
          ),

    renderImportHistory(register.id),
  );
}

// ------------------------------------------------------------------ drawer --

async function openRecord(id, registerId) {
  try {
    const record = await api(`/api/records/${id}`);
    state.drawer = { record, registerId: registerId ?? record.register, isNew: false, draft: {} };
    render();
  } catch (error) {
    toast(error.message);
  }
}

function openNew(registerId) {
  state.drawer = {
    record: { id: null, register: registerId, data: {} },
    registerId,
    isNew: true,
    draft: {},
  };
  render();
}

function renderDrawer() {
  const { record, registerId, isNew, draft } = state.drawer;
  const register = registerById(registerId);
  if (!register) return null;

  const valueOf = (key) => (key in draft ? draft[key] : (record.data?.[key] ?? ''));

  const fieldInput = (field) => {
    const common = {
      id: `f-${field.key}`,
      value: valueOf(field.key),
      oninput: (e) => {
        draft[field.key] = e.target.value;
      },
      onchange: (e) => {
        draft[field.key] = e.target.value;
      },
    };

    if (field.type === 'longtext') return h('textarea', common);

    if (field.type === 'select') {
      return h(
        'select',
        {
          ...common,
          onchange: (e) => {
            draft[field.key] = e.target.value;
            // Priority and status drive the row's colour and the dashboard, so the
            // drawer redraws immediately rather than waiting for a save.
            render();
          },
        },
        // An imported row often has no Status or Priority cell at all. Saying so is
        // clearer than a bare dash, because the table shows the fallback the app
        // applies ("Not Started", "Medium") and the two would otherwise disagree.
        h('option', { value: '' }, '— not set'),
        field.options.map((option) =>
          h('option', { value: option, selected: String(valueOf(field.key)) === option }, option),
        ),
      );
    }

    if (field.type === 'date') {
      // The date column may legitimately hold a phrase ("Next Shutdown"), so a
      // plain date picker would refuse the team's own vocabulary. A date input is
      // offered when the value is a date, with a text escape hatch beside it.
      const raw = String(valueOf(field.key) ?? '');
      const isDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) || raw === '';
      return isDate
        ? h('input', { ...common, type: 'date' })
        : h('input', { ...common, type: 'text' });
    }

    if (field.type === 'number') return h('input', { ...common, type: 'number' });

    return h('input', { ...common, type: 'text' });
  };

  const extraKeys = Object.keys(record.data ?? {}).filter((key) => key.startsWith('extra:'));

  const save = async () => {
    try {
      const payload = isNew ? { ...(record.data ?? {}), ...draft } : draft;
      if (isNew) {
        await api('/api/records', { json: { register: registerId, data: payload } });
        toast('Entry added.');
      } else {
        await api(`/api/records/${record.id}`, { method: 'PATCH', json: { data: payload } });
        toast('Saved.');
      }
      state.drawer = null;
      if (state.view === 'register') loadList();
      else loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  };

  const remove = async () => {
    if (!confirm('Delete this entry for everyone? This cannot be undone.')) return;
    try {
      await api(`/api/records/${record.id}`, { method: 'DELETE' });
      toast('Deleted.');
      state.drawer = null;
      if (state.view === 'register') loadList();
      else loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  };

  return h(
    'div',
    {
      class: 'scrim',
      onclick: (event) => {
        if (event.target === event.currentTarget) {
          state.drawer = null;
          render();
        }
      },
    },
    h(
      'div',
      { class: 'drawer' },
      h(
        'header',
        null,
        h(
          'h2',
          null,
          isNew ? `New ${register.name} entry` : (record.ref ?? register.name),
        ),
        !isNew && priorityChip(draft.priority ?? record.priority),
        !isNew && dueChip(record),
        h(
          'button',
          {
            class: 'btn ghost sm',
            onclick: () => {
              state.drawer = null;
              render();
            },
          },
          '✕',
        ),
      ),

      h(
        'div',
        { class: 'body' },
        !isNew &&
          h(
            'p',
            { class: 'hint' },
            `Last updated ${fmtWhen(record.updatedAt)}${record.updatedBy ? ` by ${record.updatedBy}` : ''}${record.source?.startsWith('import:') ? ` · from ${record.source.slice(7)}` : ''}`,
          ),

        register.fields.map((field) =>
          h('label', { class: 'field' }, h('span', null, field.label), fieldInput(field)),
        ),

        extraKeys.length > 0 &&
          h(
            'div',
            null,
            h('div', { class: 'nav-label', style: 'padding-left: 0' }, 'Extra columns from the sheet'),
            extraKeys.map((key) =>
              h(
                'label',
                { class: 'field', style: 'margin-bottom: 10px' },
                h('span', null, key.slice(6)),
                h('input', {
                  type: 'text',
                  value: valueOf(key),
                  oninput: (e) => {
                    draft[key] = e.target.value;
                  },
                }),
              ),
            ),
          ),
      ),

      h(
        'footer',
        null,
        !isNew && h('button', { class: 'btn danger', onclick: remove }, 'Delete'),
        h('div', { class: 'spacer', style: 'flex: 1' }),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              state.drawer = null;
              render();
            },
          },
          'Cancel',
        ),
        h('button', { class: 'btn primary', onclick: save }, isNew ? 'Add entry' : 'Save changes'),
      ),
    ),
  );
}

// ------------------------------------------------------------------ import --

/** Registers that more than one selected sheet feeds, as [name, count] pairs. */
function combinedRegisters(imp) {
  const counts = new Map();
  for (const choice of imp.choices ?? []) {
    if (!choice.include || !choice.register) continue;
    counts.set(choice.register, (counts.get(choice.register) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => [registerById(id)?.name ?? id, count]);
}

function renderImport() {
  const imp = state.importState;

  const inspect = async (file) => {
    if (!file) return;
    state.importState = { stage: 'reading', filename: file.name };
    render();
    try {
      const body = new FormData();
      body.append('file', file);
      const result = await api('/api/import/inspect', { method: 'POST', body });
      // Choices made the last time this same file was uploaded win over the
      // detector's guess: if someone corrected a mapping once, they should not
      // have to correct it again every month.
      const remembered = new Map(
        (result.remembered ?? []).map((choice) => [choice.sheet, choice]),
      );

      state.importState = {
        stage: 'confirm',
        filename: result.filename,
        token: result.token,
        sheets: result.sheets,
        reused: remembered.size > 0,
        // Sheets the reader could not identify, or that hold no rows, start switched
        // off — importing an empty sheet is never what anyone meant to do.
        choices: result.sheets.map((sheet) => {
          const previous = remembered.get(sheet.name);
          return {
            include: Boolean(previous?.register ?? sheet.suggestedRegister) && sheet.dataRows > 0,
            register: previous?.register ?? sheet.suggestedRegister ?? '',
            mode: previous?.mode ?? 'replace',
          };
        }),
      };
    } catch (error) {
      state.importState = { stage: 'error', message: error.message };
    }
    render();
  };

  const commit = async () => {
    const selections = imp.sheets
      .map((sheet, i) => ({ sheet: sheet.name, ...imp.choices[i] }))
      .filter((choice) => choice.include && choice.register)
      .map(({ sheet, register, mode }) => ({ sheet, register, mode }));

    if (!selections.length) return toast('Tick at least one sheet to import.');

    state.importState = { ...imp, stage: 'importing' };
    render();
    try {
      const result = await api('/api/import/commit', {
        json: { token: imp.token, selections },
      });
      state.importState = { stage: 'done', filename: imp.filename, results: result.results };
      state.imports = null;
      loadDashboard();
    } catch (error) {
      state.importState = { ...imp, stage: 'confirm', error: error.message };
    }
    render();
  };

  if (!imp || imp.stage === 'error') {
    return h(
      'div',
      { class: 'content' },
      imp?.message && h('div', { class: 'banner error' }, imp.message),
      h(
        'section',
        { class: 'card' },
        h('header', null, h('h2', null, 'Import from Excel')),
        h(
          'p',
          { class: 'hint', style: 'margin-top: -6px; margin-bottom: 14px' },
          'Upload your Engineering Master file or an Action Notice sheet. Every sheet in the workbook is read separately, and you choose which register each one goes into.',
        ),
        h(
          'div',
          {
            class: 'dropzone',
            ondragover: (e) => {
              e.preventDefault();
              e.currentTarget.classList.add('over');
            },
            ondragleave: (e) => e.currentTarget.classList.remove('over'),
            ondrop: (e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('over');
              inspect(e.dataTransfer.files[0]);
            },
          },
          h('p', { style: 'margin: 0 0 12px; font-size: 15px' }, 'Drop an .xlsx file here'),
          h('p', { class: 'hint', style: 'margin: 0 0 16px' }, 'or'),
          h('input', {
            type: 'file',
            id: 'file-input',
            accept: '.xlsx,.xlsm',
            style: 'display: none',
            onchange: (e) => inspect(e.target.files[0]),
          }),
          h(
            'button',
            { class: 'btn primary', onclick: () => $('#file-input').click() },
            'Choose a file',
          ),
        ),
      ),
      renderImportHistory(),
    );
  }

  if (imp.stage === 'reading' || imp.stage === 'importing') {
    return h(
      'div',
      { class: 'content' },
      h(
        'div',
        { class: 'card empty' },
        h('span', { class: 'spin' }),
        ' ',
        imp.stage === 'reading' ? `Reading ${imp.filename}…` : 'Importing…',
      ),
    );
  }

  if (imp.stage === 'done') {
    return h(
      'div',
      { class: 'content' },
      h(
        'section',
        { class: 'card' },
        h('header', null, h('h2', null, `Imported from ${imp.filename}`)),
        h(
          'div',
          { class: 'table-wrap', style: 'border: 0' },
          h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'Sheet'),
                h('th', null, 'Register'),
                h('th', { class: 'num' }, 'Rows added'),
                h('th', { class: 'num' }, 'Replaced'),
                h('th', { class: 'num' }, 'Blank rows skipped'),
                h('th', { class: 'num' }, 'Without a due date'),
              ),
            ),
            h(
              'tbody',
              null,
              imp.results.map((result) =>
                h(
                  'tr',
                  null,
                  h('td', null, result.sheet),
                  h(
                    'td',
                    null,
                    result.error
                      ? h('span', { class: 'chip s-overdue' }, result.error)
                      : result.registerName,
                  ),
                  h('td', { class: 'num' }, result.imported ?? '—'),
                  h('td', { class: 'num muted' }, result.replaced || '—'),
                  h('td', { class: 'num muted' }, result.skippedBlankRows || '—'),
                  h('td', { class: 'num muted' }, result.undated || '—'),
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: 'display: flex; gap: 8px; margin-top: 16px' },
          h('button', { class: 'btn primary', onclick: () => go('dashboard') }, 'Go to dashboard'),
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                state.importState = null;
                render();
              },
            },
            'Import another file',
          ),
        ),
      ),
    );
  }

  // stage === 'confirm'
  return h(
    'div',
    { class: 'content' },
    imp.error && h('div', { class: 'banner error' }, imp.error),
    imp.reused &&
      h(
        'div',
        { class: 'banner info' },
        'Filled in from the last time this file was imported. Change anything that is different this month.',
      ),
    // Several sheets feeding one register is normal — an SHP master sheet and a
    // DCU master sheet both belong in IWS — but it is worth saying out loud that
    // they combine, because "Replace" on each of them reads like each one wins.
    combinedRegisters(imp).map(([name, count]) =>
      h(
        'div',
        { class: 'banner info' },
        `${count} sheets go into ${name}. They will be added together, not one over the other.`,
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, `${imp.filename} — ${imp.sheets.length} sheet${imp.sheets.length === 1 ? '' : 's'}`),
        h('span', { class: 'hint' }, 'check each one, then import'),
      ),
      h(
        'div',
        { style: 'display: flex; flex-direction: column; gap: 12px' },
        imp.sheets.map((sheet, i) => {
          const choice = imp.choices[i];
          return h(
            'div',
            { class: `sheet-card${choice.include ? '' : ' off'}` },
            h(
              'div',
              { class: 'sheet-head' },
              h(
                'label',
                { class: 'switch' },
                h('input', {
                  type: 'checkbox',
                  checked: choice.include,
                  onchange: (e) => {
                    choice.include = e.target.checked;
                    render();
                  },
                }),
                h('strong', null, sheet.name),
              ),
              h('span', { class: 'pill' }, `${sheet.dataRows} data row${sheet.dataRows === 1 ? '' : 's'}`),
              sheet.headerRow && h('span', { class: 'pill' }, `header on row ${sheet.headerRow}`),
              !sheet.suggestedRegister &&
                h('span', { class: 'chip s-overdue' }, 'Not recognised — choose a register'),
            ),

            h(
              'div',
              { class: 'sheet-controls' },
              h(
                'label',
                { class: 'field' },
                h('span', null, 'Import into'),
                h(
                  'select',
                  {
                    value: choice.register,
                    onchange: (e) => {
                      choice.register = e.target.value;
                      render();
                    },
                  },
                  h('option', { value: '' }, 'Choose a register…'),
                  state.config.registers.map((register) =>
                    h(
                      'option',
                      { value: register.id, selected: choice.register === register.id },
                      register.name,
                    ),
                  ),
                ),
              ),
              h(
                'label',
                { class: 'field' },
                h('span', null, 'How'),
                h(
                  'select',
                  {
                    value: choice.mode,
                    onchange: (e) => {
                      choice.mode = e.target.value;
                      render();
                    },
                  },
                  h(
                    'option',
                    { value: 'replace', selected: choice.mode === 'replace' },
                    'Replace everything in this register',
                  ),
                  h('option', { value: 'append', selected: choice.mode === 'append' }, 'Add to what is there'),
                ),
              ),
            ),

            sheet.mappedColumns?.length > 0 &&
              h(
                'div',
                { class: 'hint' },
                `Matched ${sheet.mappedColumns.length} columns: ${sheet.mappedColumns.map((c) => c.label).join(', ')}`,
              ),
            sheet.unmappedColumns?.length > 0 &&
              h(
                'div',
                { class: 'hint' },
                `Kept as extra columns: ${sheet.unmappedColumns.join(', ')}`,
              ),

            // Said before importing, not discovered afterwards in a row count.
            sheet.missingKeyColumns?.length > 0 &&
              h(
                'div',
                { class: 'banner warn', style: 'margin-top: 4px' },
                sheet.missingKeyColumns
                  .map(({ role, label }) =>
                    role === 'due'
                      ? `No "${label}" column found in this sheet — all ${sheet.dataRows} rows will import with no due date, and will not appear in Overdue or Due in ${state.config.dueSoonDays} days. Check the heading spelling in Excel, or set the dates in the app afterwards.`
                      : `No "${label}" column found in this sheet.`,
                  )
                  .join(' '),
              ),
          );
        }),
      ),

      h(
        'div',
        { style: 'display: flex; gap: 8px; margin-top: 18px; align-items: center' },
        h('button', { class: 'btn primary', onclick: commit }, 'Import selected sheets'),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              state.importState = null;
              render();
            },
          },
          'Cancel',
        ),
        h(
          'span',
          { class: 'hint' },
          '“Replace” clears that register first — use it when the sheet is the master copy.',
        ),
      ),
    ),
  );
}

/**
 * The workbooks imported so far.
 *
 * Kept because "which file did these rows come from?" is a real question months
 * later, and the answer should be the file itself rather than somebody's memory.
 */
function renderImportHistory(registerId = null) {
  const scope = registerId ?? 'all';

  if (state.imports === null || state.importsScope !== scope) {
    state.importsScope = scope;
    api(`/api/imports${registerId ? `?register=${registerId}` : ''}`)
      .then((data) => {
        state.imports = data.imports;
        render();
      })
      .catch(() => {
        state.imports = [];
      });
    return null;
  }

  if (!state.imports.length) return null;

  const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

  return h(
    'section',
    { class: 'card' },
    h(
      'header',
      null,
      h('h2', null, registerId ? 'Files imported into this register' : 'Previously imported'),
      h('span', { class: 'hint' }, 'the last 20 uploads'),
    ),
    h(
      'div',
      { class: 'table-wrap', style: 'border: 0' },
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'File'),
            !registerId && h('th', null, 'Sheets imported'),
            h('th', null, 'Uploaded by'),
            h('th', null, 'When'),
            h('th', { class: 'num' }, 'Rows'),
            h('th', null, ''),
          ),
        ),
        h(
          'tbody',
          null,
          state.imports.map((entry) =>
            h(
              'tr',
              null,
              h('td', null, h('span', { class: 'cell-ref' }, entry.filename)),
              !registerId &&
                h(
                  'td',
                  { class: 'muted' },
                  (entry.results ?? [])
                    .filter((r) => r.registerName)
                    .map((r) => r.registerName)
                    .join(', ') || '—',
                ),
              h('td', null, entry.uploadedBy ?? '—'),
              h('td', { class: 'muted' }, fmtWhen(entry.uploadedAt)),
              h(
                'td',
                { class: 'num' },
                (entry.results ?? [])
                  .filter((r) => !registerId || r.register === registerId)
                  .reduce((sum, r) => sum + (r.imported ?? 0), 0),
              ),
              h(
                'td',
                null,
                entry.contentStored === false
                  ? h('span', { class: 'hint' }, 'not stored offline')
                  : h(
                      'button',
                      {
                        class: 'btn sm',
                        onclick: () => download(`/api/imports/${entry.id}/file`),
                      },
                      `↓ ${kb(entry.sizeBytes)}`,
                    ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- activity --

function renderActivity() {
  return h(
    'div',
    { class: 'content' },
    h(
      'section',
      { class: 'card' },
      h('header', null, h('h2', null, 'Recent changes'), h('span', { class: 'hint' }, 'newest first')),
      state.activity === null
        ? h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading…')
        : state.activity.length === 0
          ? h('div', { class: 'empty' }, 'No changes recorded yet.')
          : h('div', { class: 'activity-list' }, state.activity.map(activityItem)),
    ),
  );
}

// ------------------------------------------------------------------ render --

function titleFor() {
  if (state.view === 'dashboard') return ['Dashboard', 'Everything the team is tracking, in one place'];
  if (state.view === 'import') return ['Import Excel', 'One sheet at a time, into the register you choose'];
  if (state.view === 'activity') return ['Recent changes', 'Who changed what, and when'];
  const register = registerById(state.registerId);
  return [register?.name ?? 'Register', register?.description ?? ''];
}

function applyTheme() {
  if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);
}

function render() {
  const root = $('#root');

  // A full redraw would drop the caret out of whatever the user is typing in, so
  // the focused element and its selection are captured and restored around it.
  const active = document.activeElement;
  const focusId = active?.id || null;
  const selStart = active?.selectionStart ?? null;
  const selEnd = active?.selectionEnd ?? null;

  root.replaceChildren();

  if (!state.config) {
    root.append(h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading tracker…'));
    return;
  }

  if (state.gate) {
    root.append(renderGate());
    const field = $('#gate-code') ?? $('#gate-name');
    field?.focus();
    return;
  }

  const [title, subtitle] = titleFor();

  const body =
    state.view === 'dashboard'
      ? renderDashboard()
      : state.view === 'register'
        ? renderRegister()
        : state.view === 'import'
          ? renderImport()
          : renderActivity();

  root.append(
    h(
      'div',
      { class: 'shell' },
      renderSidebar(),
      h(
        'main',
        { class: 'main' },
        h(
          'div',
          { class: 'topbar' },
          h('h1', null, title, h('span', { class: 'sub' }, subtitle)),
          state.busy && h('span', { class: 'spin' }),
          h(
            'button',
            {
              class: 'btn ghost sm',
              title: 'Switch light / dark',
              onclick: () => {
                state.theme = state.theme === 'dark' ? 'light' : 'dark';
                localStorage.setItem('tracker.theme', state.theme);
                applyTheme();
                render();
              },
            },
            state.theme === 'dark' ? '☀ Light' : '☾ Dark',
          ),
          h('button', { class: 'btn', onclick: () => download('/api/export') }, '↓ Export all'),
          h('button', { class: 'btn primary', onclick: () => go('import') }, '↑ Import Excel'),
        ),
        state.error && h('div', { class: 'content' }, h('div', { class: 'banner error' }, state.error)),
        // The standalone build says where its data lives. Someone who was handed a
        // file rather than a URL has no other way to know their edits are local.
        state.config.storageNotice &&
          h(
            'div',
            { class: 'content', style: 'padding-bottom: 0' },
            h('div', { class: 'banner info' }, state.config.storageNotice),
          ),
        body,
      ),
    ),
  );

  if (state.drawer) root.append(renderDrawer());
  if (state.toast) root.append(h('div', { class: 'toast' }, state.toast));

  if (focusId) {
    const restored = document.getElementById(focusId);
    if (restored) {
      restored.focus();
      if (selStart !== null && restored.setSelectionRange) {
        try {
          restored.setSelectionRange(selStart, selEnd);
        } catch {
          // Inputs like `type=date` reject setSelectionRange; focus alone is enough.
        }
      }
    }
  }
}

// -------------------------------------------------------------------- boot --

async function boot() {
  applyTheme();
  try {
    state.config = await api('/api/config');
  } catch {
    $('#root').replaceChildren(
      h('div', { class: 'empty' }, 'Cannot reach the tracker server. Is it running?'),
    );
    return;
  }

  if (state.config.requiresAccessCode && !state.accessCode) state.gate = 'code';
  else if (!state.user) state.gate = 'name';

  if (state.gate) render();
  else go('dashboard');
}

boot();
