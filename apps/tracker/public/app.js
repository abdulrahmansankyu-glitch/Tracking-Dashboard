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
  token: localStorage.getItem('tracker.token') ?? '',
  me: null, // the signed-in account
  authState: null, // { needsSetup, requiresSetupCode, roles, disabled }
  users: null, // the team, for admins
  confirmToken: '', // password re-confirmation for Settings — memory only, on purpose
  confirmExpires: 0,
  confirmPrompt: null, // { error } while asking
  logo: null, // the report logo, once loaded
  reminders: null, // { config, mail, runs, weekdays } for admins
  reminderPreview: null, // who today's digest would go to, before sending
  reminderTest: null, // { ok, message } from the last test send — kept on screen
  theme: localStorage.getItem('tracker.theme') ?? 'auto',
  gate: null, // 'setup' | 'login' | 'name' | null
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
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (state.confirmToken) headers['x-confirm-token'] = state.confirmToken;
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

  // The sign-in routes are the one place a 401 is an answer rather than a
  // problem — bouncing somebody back to the form they are already looking at
  // would replace "that password is wrong" with something vaguer.
  // `/api/auth/confirm` belongs here too: a 401 from it means "that password is
  // wrong", not "your session ended". Treating it as the latter signed the admin
  // out for one mistyped character.
  const isAuthRoute = [
    '/api/session',
    '/api/auth/login',
    '/api/auth/setup',
    '/api/auth/password',
    '/api/auth/confirm',
  ].includes(path);
  if (response.status === 401 && !isAuthRoute) {
    signOut({ silent: true });
    throw new Error('Please sign in.');
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

const ROLE_LABELS = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };
const roleLabel = (role) => ROLE_LABELS[role] ?? role;

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

  // The normalised value, and underneath it the word the sheet actually used
  // when they differ. QC's "Finding Classification" reads `Execution`, which
  // becomes High — showing only "High" in a column headed Finding
  // Classification looks like the wrong data rather than a derived one. The
  // same goes for PDM's `Alarm` and IWS's `P1`.
  if (field.key === roles.priority) {
    return h(
      'td',
      null,
      priorityChip(record.priority),
      raw && String(raw) !== record.priority ? h('div', { class: 'hint' }, String(raw)) : null,
    );
  }

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

  // Stored as a whole number of percent, so the sign belongs with it.
  if (field.type === 'percent') return h('td', { class: 'num' }, `${raw}%`);

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

  // Settings asks for the password first. The view stays where it was, so the
  // page behind the prompt is the one they were on — cancelling leaves them
  // there rather than on a Settings page they never got into.
  if (view === 'settings' && !hasConfirmation()) {
    state.view = 'dashboard';
    state.confirmPrompt = { error: null };
    render();
    return;
  }

  if (view === 'dashboard') loadDashboard();
  else if (view === 'register') {
    state.query = defaultQuery();
    state.list = null;
    loadList();
  } else if (view === 'settings') {
    state.users = null;
    render();
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

/** What the signed-in account may do. Offline builds behave as a lone admin. */
const canWrite = () => ['editor', 'admin'].includes(state.me?.role);
// Managing accounts only means something where accounts exist. The offline build
// treats its holder as an admin so nothing is hidden from them, but there is
// nobody to administer.
const canManage = () => state.me?.role === 'admin' && !state.authState?.disabled;

/** The registers this account may open, in the catalogue's order. */
function myRegisters() {
  const all = state.config?.registers ?? [];
  const allowed = state.me?.registers ?? [];
  return allowed.length ? all.filter((r) => allowed.includes(r.id)) : all;
}

/** Is the password confirmation still fresh? */
const hasConfirmation = () => Boolean(state.confirmToken) && Date.now() < state.confirmExpires;

/**
 * Ask for the signed-in account's own password before opening Settings.
 *
 * Being signed in is not enough for the screen that decides who gets in: an admin
 * who steps away from an unlocked browser would otherwise be leaving the team's
 * permissions open to whoever sits down next. The confirmation lives in memory
 * only and lasts fifteen minutes, so closing the tab ends it.
 */
function renderConfirmPrompt() {
  let password = '';

  const close = () => {
    state.confirmPrompt = null;
    render();
  };

  return h(
    'div',
    {
      class: 'scrim modal-centre',
      onclick: (event) => {
        if (event.target === event.currentTarget) close();
      },
    },
    h(
      'form',
      {
        class: 'modal',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const result = await api('/api/auth/confirm', { json: { password } });
            state.confirmToken = result.confirmToken;
            state.confirmExpires = Date.now() + result.expiresInMs - 5000;
            state.confirmPrompt = null;
            go('settings');
          } catch (error) {
            state.confirmPrompt = { error: error.message };
            render();
          }
        },
      },
      h('h2', null, 'Confirm your password'),
      h(
        'p',
        { class: 'hint', style: 'margin: 8px 0 16px' },
        'Settings decides who can open this tracker and what they can change, so it asks again even though you are signed in.',
      ),
      state.confirmPrompt?.error &&
        h('div', { class: 'banner error', style: 'margin-bottom: 12px' }, state.confirmPrompt.error),
      h(
        'label',
        { class: 'field' },
        h('span', null, `Password for ${state.me?.email ?? 'your account'}`),
        h('input', {
          type: 'password',
          id: 'confirm-password',
          autocomplete: 'current-password',
          autofocus: 'autofocus',
          oninput: (e) => {
            password = e.target.value;
          },
        }),
      ),
      h(
        'div',
        { style: 'margin-top: 18px; display: flex; gap: 8px; justify-content: flex-end' },
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Open Settings'),
      ),
    ),
  );
}

function signOut({ silent = false } = {}) {
  state.token = '';
  state.me = null;
  state.users = null;
  state.confirmToken = '';
  state.confirmExpires = 0;
  state.confirmPrompt = null;
  localStorage.removeItem('tracker.token');
  state.gate = 'login';
  state.dashboard = null;
  state.list = null;
  render();
  if (!silent) toast('Signed out.');
}

/** A labelled input that keeps its value in `form` and its focus across redraws. */
const formField = (form, key, label, { type = 'text', placeholder = '', autofocus = false } = {}) =>
  h(
    'label',
    { class: 'field' },
    h('span', null, label),
    h('input', {
      type,
      id: `auth-${key}`,
      value: form[key] ?? '',
      placeholder,
      autofocus: autofocus ? 'autofocus' : null,
      autocomplete: type === 'password' ? 'current-password' : 'on',
      oninput: (e) => {
        form[key] = e.target.value;
      },
    }),
  );

const authForm = {};

function renderGate() {
  // ---- first run: nobody has an account yet ------------------------------
  if (state.gate === 'setup') {
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
              const result = await api('/api/auth/setup', { json: { ...authForm } });
              acceptSession(result);
            } catch (error) {
              state.error = error.message;
              render();
            }
          },
        },
        h('h2', null, 'Create the first account'),
        h(
          'p',
          { class: 'hint', style: 'margin: 8px 0 16px' },
          'This account is the administrator — it can add the rest of your team and choose what each person may do.',
        ),
        state.error && h('div', { class: 'banner error', style: 'margin-bottom: 12px' }, state.error),
        h(
          'div',
          { style: 'display: flex; flex-direction: column; gap: 12px' },
          state.authState?.requiresSetupCode &&
            formField(authForm, 'accessCode', 'Team access code', {
              type: 'password',
              autofocus: true,
            }),
          formField(authForm, 'name', 'Your name', { placeholder: 'e.g. Abdul Rahman' }),
          formField(authForm, 'email', 'Email', { type: 'email', placeholder: 'you@company.com' }),
          formField(authForm, 'password', 'Password', {
            type: 'password',
            placeholder: 'At least 8 characters',
          }),
        ),
        h(
          'div',
          { style: 'margin-top: 18px; display: flex; justify-content: flex-end' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Create account'),
        ),
      ),
    );
  }

  // ---- offline build: no accounts, just a name for the audit trail -------
  if (state.gate === 'name') {
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
            state.me = { id: 'local', name, role: 'admin', registers: [] };
            state.gate = null;
            go('dashboard');
          },
        },
        h('h2', null, 'Who are you?'),
        h(
          'p',
          { class: 'hint', style: 'margin: 8px 0 16px' },
          'This offline copy has no accounts. Your name is recorded against everything you change.',
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

  // ---- normal sign-in ----------------------------------------------------
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
            const result = await api('/api/auth/login', {
              json: { email: authForm.email, password: authForm.password },
            });
            acceptSession(result);
          } catch (error) {
            state.error = error.message;
            render();
          }
        },
      },
      h(
        'div',
        { class: 'brand', style: 'padding: 0 0 14px' },
        h('div', { class: 'brand-mark' }, 'EA'),
        h(
          'div',
          { class: 'brand-text' },
          h('strong', null, 'Activity Tracker'),
          h('span', null, 'Engineering — SHP / DCU'),
        ),
      ),
      h('h2', null, 'Sign in'),
      state.error &&
        h('div', { class: 'banner error', style: 'margin: 12px 0 0' }, state.error),
      h(
        'div',
        { style: 'display: flex; flex-direction: column; gap: 12px; margin-top: 14px' },
        formField(authForm, 'email', 'Email', {
          type: 'email',
          placeholder: 'you@company.com',
          autofocus: true,
        }),
        formField(authForm, 'password', 'Password', { type: 'password' }),
      ),
      h(
        'div',
        { style: 'margin-top: 18px; display: flex; justify-content: flex-end' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
      ),
      h(
        'p',
        { class: 'hint', style: 'margin: 14px 0 0' },
        'No account? Ask an administrator on your team to create one for you.',
      ),
    ),
  );
}

/** Store a freshly issued session and go to work. */
function acceptSession({ token, user }) {
  state.token = token;
  state.me = user;
  state.user = user.name;
  state.error = null;
  state.gate = null;
  localStorage.setItem('tracker.token', token);
  localStorage.setItem('tracker.user', user.name);
  authForm.password = '';
  authForm.accessCode = '';
  go('dashboard');
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
    myRegisters().map((register) => {
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
    canWrite() &&
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

    canManage() &&
      h(
        'button',
        {
          class: 'nav-item',
          'aria-current': String(state.view === 'settings'),
          onclick: () => go('settings'),
        },
        h('span', { class: 'short' }, '⚙'),
        h('span', { class: 'grow' }, 'Settings'),
      ),

    h(
      'div',
      { class: 'sidebar-foot' },
      h('div', null, `Signed in as ${state.me?.name || state.user || '—'}`),
      state.me?.role &&
        h('div', { style: 'margin-top: 2px' }, h('span', { class: 'chip p-medium' }, roleLabel(state.me.role))),
      state.authState?.disabled
        ? h(
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
          )
        : h(
            'button',
            { class: 'btn ghost sm', style: 'margin-top: 6px; padding-left: 0', onclick: () => signOut() },
            'Sign out',
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
      kpi(
        'Total Jobs',
        t.all,
        `across ${myRegisters().length} register${myRegisters().length === 1 ? '' : 's'}`,
      ),
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
      canWrite() &&
        h(
          'button',
          { class: 'btn primary', onclick: () => openNew(register.id) },
          '+ Add entry',
        ),
      canWrite() && h('button', { class: 'btn', onclick: () => go('import') }, 'Import from Excel'),
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
                      class: field.type === 'number' || field.type === 'percent' ? 'num' : '',
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
    // Whether the reference shown is still the one the app suggested. Cleared
    // the moment somebody types in that field, which is how the server knows to
    // honour what they wrote instead of issuing a number of its own.
    autoRef: false,
  };
  render();

  // Shown as soon as the form opens, but it is a preview rather than a
  // reservation — the number is issued for real when Save is pressed, so
  // opening the form and thinking better of it does not consume one and leave
  // a gap in the sequence.
  const register = registerById(registerId);
  if (!register?.autoNumber) return;

  api(`/api/registers/${registerId}/next-ref`)
    .then(({ ref, field }) => {
      const drawer = state.drawer;
      // The form may have been closed, or another one opened, while this was
      // in flight.
      if (!drawer?.isNew || drawer.registerId !== registerId) return;
      if (drawer.draft[field]) return; // they typed faster than the network
      drawer.draft[field] = ref;
      drawer.autoRef = true;
      render();
    })
    // A failure here costs the convenience, not the entry: the field stays
    // empty and can be filled in by hand.
    .catch(() => {});
}

const AUTO_REF_HINTS = {
  auto: 'Numbered automatically — the serial restarts each month. Type over it to use your own.',
  manual: 'Using the number you typed instead of the automatic one.',
};

function renderDrawer() {
  const { record, registerId, isNew, draft } = state.drawer;
  const register = registerById(registerId);
  if (!register) return null;

  const valueOf = (key) => (key in draft ? draft[key] : (record.data?.[key] ?? ''));

  const fieldInput = (field) => {
    const write = (e) => {
      draft[field.key] = e.target.value;
      // Typing over an issued number means they want their own. From here the
      // server honours what is in the box rather than allocating.
      if (register.autoNumber?.field === field.key) {
        state.drawer.autoRef = false;
        // Updated in place rather than by re-rendering: re-rendering the field
        // somebody is typing in takes the cursor with it. Without this the hint
        // went on claiming the number was automatic after they had replaced it.
        const note = $(`#hint-${field.key}`);
        if (note) note.textContent = AUTO_REF_HINTS.manual;
      }
    };

    const common = {
      id: `f-${field.key}`,
      value: valueOf(field.key),
      oninput: write,
      onchange: write,
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

    if (field.type === 'number' || field.type === 'percent') {
      return h('input', { ...common, type: 'number' });
    }

    return h('input', { ...common, type: 'text' });
  };

  const extraKeys = Object.keys(record.data ?? {}).filter((key) => key.startsWith('extra:'));

  const save = async () => {
    try {
      const payload = isNew ? { ...(record.data ?? {}), ...draft } : draft;
      if (isNew) {
        const created = await api('/api/records', {
          json: { register: registerId, data: payload, autoRef: state.drawer.autoRef === true },
        });
        // The number the server actually issued, which may not be the one
        // previewed if somebody else saved in the meantime.
        toast(created?.ref ? `Added ${created.ref}.` : 'Entry added.');
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
          h(
            'label',
            { class: 'field' },
            h('span', null, field.label),
            fieldInput(field),
            // Said once, on the field it applies to: the number is chosen for
            // them, and typing over it is allowed rather than a mistake.
            isNew && register.autoNumber?.field === field.key
              ? h(
                  'span',
                  { class: 'hint', id: `hint-${field.key}` },
                  state.drawer.autoRef ? AUTO_REF_HINTS.auto : AUTO_REF_HINTS.manual,
                )
              : null,
          ),
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
        !isNew && canWrite() && h('button', { class: 'btn danger', onclick: remove }, 'Delete'),
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
          canWrite() ? 'Cancel' : 'Close',
        ),
        canWrite() &&
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


// ---------------------------------------------------------------- settings --

const userDraft = { registers: [] };

/** Transport names as somebody reading the screen would recognise them. */
const MAIL_PROVIDER_LABELS = {
  graph: 'Microsoft 365 (Outlook)',
  smtp: 'SMTP',
  brevo: 'Brevo',
  resend: 'Resend',
};

/**
 * Daily email reminders.
 *
 * The schedule itself lives outside this app — a free instance sleeps after
 * fifteen minutes, so an in-process timer would simply not fire. Something
 * external calls `/api/reminders/run` each morning; this screen is where the
 * rules, the recipients and the evidence of what was sent live.
 *
 * The mail password is deliberately not here. It is an environment variable on
 * the host, so it cannot leave in a database backup — this screen can see
 * whether mail works and say what is missing, but never what the password is.
 */
function renderReminders() {
  const data = state.reminders;
  if (!data) return null;

  const config = data.config;
  const save = async (patch, message) => {
    try {
      const result = await api('/api/reminders', { method: 'PUT', json: { ...config, ...patch } });
      state.reminders = { ...data, config: result.config, bandsToday: result.bandsToday };
      if (message) toast(message);
      render();
    } catch (error) {
      toast(error.message);
    }
  };

  const number = (label, key, hint, min, max) =>
    h(
      'label',
      { class: 'field' },
      h('span', null, label),
      h('input', {
        type: 'number',
        min: String(min),
        max: String(max),
        value: String(config[key]),
        title: hint,
        onchange: (e) => save({ [key]: Number(e.target.value) }),
      }),
    );

  const check = (key, label, hint) =>
    h(
      'label',
      { style: 'display: flex; gap: 9px; align-items: flex-start; cursor: pointer' },
      h('input', {
        type: 'checkbox',
        checked: config[key] ? 'checked' : null,
        style: 'margin-top: 3px',
        onchange: (e) => save({ [key]: e.target.checked }),
      }),
      h('span', null, label, hint && h('span', { class: 'hint', style: 'display: block' }, hint)),
    );

  const preview = state.reminderPreview;

  return h(
    'section',
    { class: 'card' },
    h(
      'header',
      null,
      h('h2', null, 'Daily email reminders'),
      h('span', { class: 'hint' }, config.enabled ? 'on' : 'off'),
    ),

    // What is missing, in the order it has to be fixed. A screen full of
    // settings that cannot possibly send is worse than one that says why.
    !data.mail.configured
      ? h(
          'div',
          { class: 'banner warn', style: 'margin-bottom: 14px' },
          h('strong', null, 'No mail account is connected yet. '),
          data.mail.problem,
        )
      : h(
          'div',
          { class: 'banner ok', style: 'margin-bottom: 14px' },
          `Sending through ${MAIL_PROVIDER_LABELS[data.mail.provider] ?? data.mail.provider} as ${data.mail.from}.`,
        ),

    data.scheduleConfigured
      ? null
      : h(
          'div',
          { class: 'banner info', style: 'margin-bottom: 14px' },
          'No schedule secret is set, so nothing can trigger the daily run automatically. Set TRACKER_REMINDER_SECRET on the host to switch the schedule on. You can still send from here.',
        ),

    h(
      'div',
      { style: 'display: flex; flex-direction: column; gap: 14px' },
      check(
        'enabled',
        'Send reminders automatically',
        'When this is off, the scheduled run does nothing and reminders only go out if you send them from here.',
      ),

      h(
        'div',
        { class: 'toolbar' },
        number('Remind daily within (days)', 'dailyWithinDays', 'Jobs due this many days from now are emailed every day.', 0, 365),
        number('Mention jobs up to (days)', 'windowDays', 'Jobs further away than this are not mentioned at all.', 1, 365),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Weekly look-ahead on'),
          h(
            'select',
            { onchange: (e) => save({ weeklyOn: e.target.value }) },
            (data.weekdays ?? []).map((day) =>
              h('option', { value: day, selected: config.weeklyOn === day }, day),
            ),
          ),
        ),
      ),
      h(
        'p',
        { class: 'hint', style: 'margin: -4px 0 0' },
        `Overdue jobs and anything due within ${config.dailyWithinDays} days are emailed every day. Jobs due in ${
          config.dailyWithinDays + 1
        }–${config.windowDays} days go out once a week, on ${config.weeklyOn} — daily on those would drown the urgent ones.`,
      ),

      check('includeOverdue', 'Include jobs that are already overdue'),
      check(
        'sendWhenEmpty',
        'Email people who have nothing due',
        'Off by default. A digest that arrives every morning saying "nothing" is a digest people stop opening.',
      ),

      h(
        'label',
        { class: 'field' },
        h('span', null, 'Link back to the tracker'),
        h('input', {
          type: 'url',
          value: config.appUrl ?? '',
          placeholder: 'https://engineering-tracker.onrender.com',
          style: 'width: 100%',
          onchange: (e) => save({ appUrl: e.target.value }, 'Saved.'),
        }),
      ),

      h(
        'label',
        { class: 'field' },
        h('span', null, 'Also send to (one address per line)'),
        h('textarea', {
          rows: '3',
          placeholder: 'engineering.dept@company.com',
          value: (config.extraRecipients ?? []).join('\n'),
          onchange: (e) =>
            save(
              { extraRecipients: e.target.value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean) },
              'Saved.',
            ),
        }),
      ),
      h(
        'p',
        { class: 'hint', style: 'margin: -4px 0 0' },
        'Everyone with an account is emailed already, covering only the registers their account can open. Addresses here have no account, so they receive everything.',
      ),

      h(
        'div',
        { class: 'toolbar' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              try {
                state.reminderPreview = await api('/api/reminders/preview');
                render();
              } catch (error) {
                toast(error.message);
              }
            },
          },
          'Show who gets one today',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              state.reminderTest = { ok: null, message: 'Sending…' };
              render();
              try {
                const result = await api('/api/reminders/test', { json: {} });
                state.reminderTest = { ok: true, message: `Test sent to ${result.to}. Check your inbox.` };
              } catch (error) {
                // Not a toast. A mail server's refusal runs to several lines,
                // is the thing you act on, and is what IT will ask you to
                // forward — none of which survives disappearing after three
                // seconds.
                state.reminderTest = { ok: false, message: error.message };
              }
              render();
            },
          },
          'Send a test to me',
        ),
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: async () => {
              if (!confirm("Send today's reminders to the whole team now?")) return;
              try {
                // Forced: the admin has just said to send it, so the
                // already-sent-today guard is not what they meant.
                const result = await api('/api/reminders/run', { json: { force: true } });
                toast(
                  result.sent
                    ? `Sent ${result.sent} email${result.sent === 1 ? '' : 's'}${
                        result.failed ? `, ${result.failed} failed` : ''
                      }.`
                    : 'Nobody had anything due, so nothing was sent.',
                );
                state.reminders = null;
                state.users = null;
                render();
              } catch (error) {
                toast(error.message);
              }
            },
          },
          'Send now',
        ),
      ),
    ),

    state.reminderTest
      ? h(
          'div',
          {
            class: `banner ${state.reminderTest.ok === false ? 'error' : state.reminderTest.ok ? 'ok' : 'info'}`,
            // `pre-wrap` because a mail server's answer is several lines and
            // its line breaks are where the meaning is.
            style: 'margin-top: 14px; white-space: pre-wrap',
          },
          state.reminderTest.message,
          state.reminderTest.ok === false &&
            h(
              'button',
              {
                class: 'btn ghost',
                type: 'button',
                style: 'display: block; margin-top: 10px',
                onclick: () => {
                  state.reminderTest = null;
                  render();
                },
              },
              'Dismiss',
            ),
        )
      : null,

    preview &&
      h(
        'div',
        { style: 'margin-top: 18px' },
        h(
          'div',
          { class: 'nav-label', style: 'padding-left: 0' },
          `${preview.date} (${preview.weekday}) — ${preview.messages.length} would be emailed`,
        ),
        preview.messages.length
          ? h(
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
                    h('th', null, 'To'),
                    h('th', null, 'Overdue'),
                    h('th', null, 'Due soon'),
                    h('th', null, 'Coming up'),
                    h('th', null, 'Theirs'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  preview.messages.map((m) =>
                    h(
                      'tr',
                      { key: m.to },
                      h('td', null, m.name ? `${m.name} · ${m.to}` : m.to),
                      h('td', null, String(m.counts.overdue)),
                      h('td', null, String(m.counts.urgent)),
                      h('td', null, String(m.counts.soon)),
                      h('td', null, String(m.counts.mine)),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'hint' }, 'Nobody has anything due today.'),
        // A ternary, not `&&`: a length of 0 is falsy but still a value, and
        // `h()` rendered it as a literal "0" under the buttons.
        preview.skipped.length
          ? h(
              'p',
              { class: 'hint' },
              `Not emailed: ${preview.skipped.map((s) => s.name || s.to).join(', ')} — nothing due.`,
            )
          : null,
      ),

    data.runs?.length
      ? h(
          'div',
          { style: 'margin-top: 18px' },
          h('div', { class: 'nav-label', style: 'padding-left: 0' }, 'Recent runs'),
          h(
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
                  h('th', null, 'When'),
                  h('th', null, 'Triggered by'),
                  h('th', null, 'Sent'),
                  h('th', null, 'Failed'),
                ),
              ),
              h(
                'tbody',
                null,
                data.runs.map((run) =>
                  h(
                    'tr',
                    { key: run.at },
                    h('td', null, String(run.at).slice(0, 16).replace('T', ' ')),
                    h('td', null, run.trigger),
                    h('td', null, String(run.sent)),
                    h(
                      'td',
                      { style: run.failed ? 'color: var(--critical)' : '' },
                      run.failed ? String(run.failed) : '—',
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

/**
 * Accounts and what each person may do.
 *
 * Two dimensions, because they answer different questions: the role says what
 * kind of thing somebody may do, and the register list says where. A contractor
 * who updates only PDM findings is an editor limited to PDM — expressing that
 * as a role would mean inventing a role per combination.
 */
function renderSettings() {
  if (!hasConfirmation()) {
    state.view = 'dashboard';
    state.confirmPrompt = { error: null };
    return h('div', { class: 'content' }, h('div', { class: 'empty' }, 'Confirm your password to continue.'));
  }

  if (!canManage()) {
    return h('div', { class: 'content' }, h('div', { class: 'banner error' }, 'Only an admin can open Settings.'));
  }

  if (state.users === null) {
    api('/api/report/logo')
      .then((data) => {
        state.logo = data.logo || null;
      })
      .catch(() => {});

    api('/api/reminders')
      .then((data) => {
        state.reminders = data;
        render();
      })
      // Not fatal: the offline build has no reminders, and Settings must still
      // open if this one endpoint is unavailable.
      .catch(() => {});

    api('/api/users')
      .then((data) => {
        state.users = data.users;
        render();
      })
      .catch((error) => {
        state.users = [];
        toast(error.message);
      });
    return h('div', { class: 'content' }, h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading…'));
  }

  const reload = () => {
    state.users = null;
    render();
  };

  const registerCheckboxes = (selected, onToggle) =>
    h(
      'div',
      { class: 'register-picker' },
      h(
        'label',
        { class: 'switch' },
        h('input', {
          type: 'checkbox',
          checked: selected.length === 0,
          onchange: (e) => onToggle(e.target.checked ? [] : (state.config.registers ?? []).map((r) => r.id)),
        }),
        h('strong', null, 'All registers'),
      ),
      (state.config.registers ?? []).map((register) =>
        h(
          'label',
          { class: 'switch' },
          h('input', {
            type: 'checkbox',
            checked: selected.length === 0 || selected.includes(register.id),
            disabled: selected.length === 0,
            onchange: (e) =>
              onToggle(
                e.target.checked
                  ? [...new Set([...selected, register.id])]
                  : selected.filter((id) => id !== register.id),
              ),
          }),
          register.name,
        ),
      ),
    );

  const saveUser = async (user, patch) => {
    try {
      await api(`/api/users/${user.id}`, { method: 'PATCH', json: patch });
      toast(`Saved ${user.name}.`);
      reload();
    } catch (error) {
      toast(error.message);
    }
  };

  return h(
    'div',
    { class: 'content' },

    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Your team'),
        h('span', { class: 'hint' }, `${state.users.length} account${state.users.length === 1 ? '' : 's'}`),
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
              h('th', null, 'Name'),
              h('th', null, 'Email'),
              h('th', null, 'Can do'),
              h('th', null, 'Registers'),
              h('th', null, 'Last signed in'),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            state.users.map((user) =>
              h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  h('span', { class: 'cell-ref' }, user.name),
                  user.id === state.me?.id && h('div', { class: 'hint' }, 'that is you'),
                  !user.active && h('div', null, h('span', { class: 'chip s-overdue' }, 'switched off')),
                ),
                h('td', { class: 'muted' }, user.email),
                h(
                  'td',
                  null,
                  h(
                    'select',
                    {
                      value: user.role,
                      onchange: (e) => saveUser(user, { role: e.target.value }),
                    },
                    (state.authState?.roles ?? []).map((r) =>
                      h('option', { value: r.value, selected: user.role === r.value }, roleLabel(r.value)),
                    ),
                  ),
                  h(
                    'div',
                    { class: 'hint', style: 'max-width: 260px' },
                    (state.authState?.roles ?? []).find((r) => r.value === user.role)?.description ?? '',
                  ),
                ),
                h(
                  'td',
                  null,
                  registerCheckboxes(user.registers ?? [], (registers) => saveUser(user, { registers })),
                ),
                h('td', { class: 'muted' }, user.lastLoginAt ? fmtWhen(user.lastLoginAt) : 'never'),
                h(
                  'td',
                  { style: 'white-space: nowrap' },
                  h(
                    'button',
                    {
                      class: 'btn sm',
                      onclick: () => saveUser(user, { active: !user.active }),
                    },
                    user.active ? 'Switch off' : 'Switch on',
                  ),
                  ' ',
                  h(
                    'button',
                    {
                      class: 'btn sm',
                      onclick: async () => {
                        const password = prompt(`New password for ${user.name} (at least 8 characters):`);
                        if (!password) return;
                        await saveUser(user, { password });
                      },
                    },
                    'Set password',
                  ),
                  ' ',
                  user.id !== state.me?.id &&
                    h(
                      'button',
                      {
                        class: 'btn sm danger',
                        onclick: async () => {
                          if (!confirm(`Remove the account for ${user.name}?`)) return;
                          try {
                            await api(`/api/users/${user.id}`, { method: 'DELETE' });
                            toast('Account removed.');
                            reload();
                          } catch (error) {
                            toast(error.message);
                          }
                        },
                      },
                      'Remove',
                    ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'card' },
      h('header', null, h('h2', null, 'Add someone')),
      h(
        'form',
        {
          style: 'display: flex; flex-direction: column; gap: 14px',
          onsubmit: async (event) => {
            event.preventDefault();
            try {
              await api('/api/users', { json: { ...userDraft } });
              toast(`${userDraft.name} can now sign in.`);
              userDraft.name = '';
              userDraft.email = '';
              userDraft.password = '';
              userDraft.registers = [];
              reload();
            } catch (error) {
              toast(error.message);
            }
          },
        },
        h(
          'div',
          { class: 'toolbar' },
          h(
            'label',
            { class: 'field grow' },
            h('span', null, 'Name'),
            h('input', {
              type: 'text',
              id: 'new-name',
              value: userDraft.name ?? '',
              placeholder: 'e.g. Rehan',
              required: 'required',
              oninput: (e) => {
                userDraft.name = e.target.value;
              },
            }),
          ),
          h(
            'label',
            { class: 'field grow' },
            h('span', null, 'Email'),
            h('input', {
              type: 'email',
              id: 'new-email',
              value: userDraft.email ?? '',
              placeholder: 'rehan@company.com',
              required: 'required',
              oninput: (e) => {
                userDraft.email = e.target.value;
              },
            }),
          ),
          h(
            'label',
            { class: 'field grow' },
            h('span', null, 'First password'),
            h('input', {
              type: 'text',
              id: 'new-password',
              value: userDraft.password ?? '',
              placeholder: 'At least 8 characters',
              required: 'required',
              oninput: (e) => {
                userDraft.password = e.target.value;
              },
            }),
          ),
          h(
            'label',
            { class: 'field' },
            h('span', null, 'Can do'),
            h(
              'select',
              {
                value: userDraft.role ?? 'viewer',
                onchange: (e) => {
                  userDraft.role = e.target.value;
                  render();
                },
              },
              (state.authState?.roles ?? []).map((r) =>
                h('option', { value: r.value, selected: (userDraft.role ?? 'viewer') === r.value }, roleLabel(r.value)),
              ),
            ),
          ),
        ),
        h(
          'div',
          null,
          h('div', { class: 'nav-label', style: 'padding-left: 0' }, 'Which registers'),
          registerCheckboxes(userDraft.registers ?? [], (registers) => {
            userDraft.registers = registers;
            render();
          }),
        ),
        h(
          'p',
          { class: 'hint', style: 'margin: 0' },
          'You will need to tell them this password yourself — the app does not email invitations. They can change it once they are in.',
        ),
        h(
          'div',
          null,
          h('button', { class: 'btn primary', type: 'submit' }, 'Create account'),
        ),
      ),
    ),

    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Report logo'),
        h('span', { class: 'hint' }, 'printed on the PDF report'),
      ),
      h(
        'p',
        { class: 'hint', style: 'margin: -6px 0 12px' },
        'A PNG or JPG under about 400 KB, ideally a wide image on a transparent or white background. It appears beside the "Engineering Department Updates" heading.',
      ),
      state.logo &&
        h('img', {
          src: state.logo,
          alt: 'Current report logo',
          style: 'max-height: 46px; max-width: 220px; margin-bottom: 12px; display: block',
        }),
      h(
        'div',
        { class: 'toolbar' },
        h('input', {
          type: 'file',
          id: 'logo-input',
          accept: 'image/png,image/jpeg',
          style: 'display: none',
          onchange: async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
              try {
                await api('/api/report/logo', { method: 'PUT', json: { logo: reader.result } });
                state.logo = reader.result;
                toast('Logo saved — it will appear on the next report.');
                render();
              } catch (error) {
                toast(error.message);
              }
            };
            reader.readAsDataURL(file);
          },
        }),
        h(
          'button',
          { class: 'btn primary', type: 'button', onclick: () => $('#logo-input').click() },
          state.logo ? 'Replace logo' : 'Upload logo',
        ),
        state.logo &&
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: async () => {
                try {
                  await api('/api/report/logo', { method: 'PUT', json: { logo: null } });
                  state.logo = null;
                  toast('Logo removed.');
                  render();
                } catch (error) {
                  toast(error.message);
                }
              },
            },
            'Remove',
          ),
        h(
          'button',
          { class: 'btn ghost', type: 'button', onclick: () => download('/api/report.pdf') },
          'Preview the report',
        ),
      ),
    ),

    renderReminders(),

    h(
      'section',
      { class: 'card' },
      h('header', null, h('h2', null, 'Your password')),
      h(
        'form',
        {
          class: 'toolbar',
          onsubmit: async (event) => {
            event.preventDefault();
            const currentPassword = $('#current-password').value;
            const newPassword = $('#next-password').value;
            try {
              await api('/api/auth/password', { json: { currentPassword, newPassword } });
              toast('Password changed.');
              $('#current-password').value = '';
              $('#next-password').value = '';
            } catch (error) {
              toast(error.message);
            }
          },
        },
        h(
          'label',
          { class: 'field grow' },
          h('span', null, 'Current password'),
          h('input', { type: 'password', id: 'current-password', required: 'required' }),
        ),
        h(
          'label',
          { class: 'field grow' },
          h('span', null, 'New password'),
          h('input', { type: 'password', id: 'next-password', required: 'required' }),
        ),
        h('button', { class: 'btn', type: 'submit' }, 'Change password'),
      ),
    ),
  );
}

// ------------------------------------------------------------------ render --

function titleFor() {
  if (state.view === 'dashboard') return ['Dashboard', 'Everything the team is tracking, in one place'];
  if (state.view === 'import') return ['Import Excel', 'One sheet at a time, into the register you choose'];
  if (state.view === 'activity') return ['Recent changes', 'Who changed what, and when'];
  if (state.view === 'settings') return ['Settings', 'Accounts, and what each person may do'];
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
    if (!focusId) ($('#gate-name') ?? $('#auth-accessCode') ?? $('#auth-email'))?.focus();
    else document.getElementById(focusId)?.focus();
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
          : state.view === 'settings'
            ? renderSettings()
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
          h(
            'button',
            {
              class: 'btn',
              title: 'Engineering Department Updates — summary and what needs attention',
              onclick: () =>
                state.authState?.disabled
                  ? // No server offline to render a PDF; the browser's own
                    // "Save as PDF" prints the same content from the page.
                    window.print()
                  : download('/api/report.pdf'),
            },
            '↓ PDF report',
          ),
          h('button', { class: 'btn', onclick: () => download('/api/export') }, '↓ Export all'),
          canWrite() &&
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

  if (state.confirmPrompt) {
    root.append(renderConfirmPrompt());
    if (!focusId) $('#confirm-password')?.focus();
  }
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
    state.authState = await api('/api/auth/state');
  } catch {
    $('#root').replaceChildren(
      h('div', { class: 'empty' }, 'Cannot reach the tracker server. Is it running?'),
    );
    return;
  }

  // The offline build has no accounts — it asks for a name and treats whoever is
  // holding the file as able to do everything, because they already are.
  if (state.authState.disabled) {
    if (state.user) {
      state.me = { id: 'local', name: state.user, role: 'admin', registers: [] };
      go('dashboard');
    } else {
      state.gate = 'name';
      render();
    }
    return;
  }

  if (state.authState.needsSetup) {
    state.gate = 'setup';
    render();
    return;
  }

  if (!state.token) {
    state.gate = 'login';
    render();
    return;
  }

  try {
    const { user } = await api('/api/auth/me');
    state.me = user;
    state.user = user?.name ?? '';
    go('dashboard');
  } catch {
    // The token was rejected — `api` has already cleared it and shown the form.
    render();
  }
}

boot();
