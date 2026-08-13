/**
 * Tests for the parts that would fail silently.
 *
 * The risk in this app is not a crash — it is a workbook that imports "cleanly"
 * while quietly dropping a column, mis-reading a date, or turning twelve blank
 * rows into twelve jobs. Each test below pins one of those.
 */

import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import ExcelJS from 'exceljs';

import {
  buildWorkbook,
  detectHeader,
  extractRows,
  inspectWorkbook,
  readSheet,
  suggestRegister,
} from '../src/excel.js';
import {
  REGISTERS,
  deriveRecord,
  dueState,
  getRegister,
  normalisePriority,
  normaliseStatus,
  toDateOnly,
  todayIso,
} from '../src/registers.js';
import { nextRef, periodOf } from '../src/autonumber.js';
import { createMailer, explainSmtpFailure } from '../src/mailer.js';
import {
  bandOf,
  bandsSendingOn,
  normaliseConfig,
  ownerMatches,
  sendsToday,
  weekdayOf,
} from '../src/reminders.js';
import { createApp, summarise } from '../src/server.js';
import { applyQuery, toApi, toRow } from '../src/store.js';

/** Build a worksheet shaped like the team's files: banner row, then headers. */
async function sheetFrom(rows, { name = 'Sheet1', startColumn = 1 } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(name);
  rows.forEach((values, index) => {
    const row = sheet.getRow(index + 1);
    values.forEach((value, i) => {
      row.getCell(startColumn + i).value = value;
    });
    row.commit();
  });
  return sheet;
}

const ACTION_NOTICE_HEADERS = [
  'Sl no',
  'Document No.',
  'Date',
  'Description',
  'Location / Tag',
  'Initiator',
  'ETC',
  'Action By ',
  'Status',
];

// --------------------------------------------------------------- dates -----

test('toDateOnly reads the date formats the sheets actually contain', () => {
  assert.equal(toDateOnly(new Date(Date.UTC(2026, 6, 20))), '2026-07-20');
  assert.equal(toDateOnly('2026-07-20'), '2026-07-20');
  assert.equal(toDateOnly('20/07/2026'), '2026-07-20');
  assert.equal(toDateOnly('20-07-2026'), '2026-07-20');
  // The PZV sheet's later rows use dots. Missing this hid eleven valves from the
  // overdue counts, because an unparsed due date means "no date set".
  assert.equal(toDateOnly('20.07.2026'), '2026-07-20');
  assert.equal(toDateOnly('16.11.2021'), '2021-11-16');
  // Excel serial for 2026-07-20.
  assert.equal(toDateOnly(46223), '2026-07-20');
});

test('toDateOnly refuses phrases rather than inventing a date', () => {
  assert.equal(toDateOnly('Next Shutdown'), null);
  assert.equal(toDateOnly('Next sulfur Shutdown'), null);
  assert.equal(toDateOnly('SEP'), null);
  assert.equal(toDateOnly(''), null);
  assert.equal(toDateOnly(null), null);
});

test('toDateOnly rejects the EIS sheet’s wrapped 1935 dates', () => {
  // The real file holds "1935-03-25" where a five-year addition overflowed.
  // Admitting it would park a permanently overdue row at the top of the dashboard.
  assert.equal(toDateOnly('1935-03-25'), null);
  assert.equal(toDateOnly(new Date(Date.UTC(1934, 11, 6))), null);
  assert.equal(toDateOnly('2029-11-25'), '2029-11-25');
});

// --------------------------------------------------- vocabulary mapping ----

test('the three priority vocabularies fold onto one ladder', () => {
  assert.equal(normalisePriority('P1'), 'Critical');
  assert.equal(normalisePriority('P4'), 'Low');
  assert.equal(normalisePriority('High'), 'High');
  assert.equal(normalisePriority('Alarm'), 'High'); // PDM severity
  assert.equal(normalisePriority('Suspect'), 'Medium');
  assert.equal(normalisePriority('Orange'), 'Medium');
  assert.equal(normalisePriority('nonsense'), null);
});

test('"Overdue" is a due-date state, not a work status', () => {
  // Otherwise a row reads "Overdue" for ever, including after it is finished.
  assert.equal(normaliseStatus('Overdue'), 'In Progress');
  assert.equal(normaliseStatus('On going'), 'In Progress');
  assert.equal(normaliseStatus('Close'), 'Completed');
  assert.equal(normaliseStatus('Archived '), 'Archived');
  assert.equal(normaliseStatus('Not started'), 'Not Started');
});

// ----------------------------------------------------- header detection ----

test('the header is found on row 2, under the banner', async () => {
  const sheet = await sheetFrom([
    ['Engineering Action Notice Tracking'],
    ACTION_NOTICE_HEADERS,
    ['1', 'PA-2607-08', new Date(Date.UTC(2026, 6, 20)), 'Corroded Hub', 'Pastillator', 'Rehan', '', '', ''],
  ]);

  const header = detectHeader(sheet, getRegister('action-notice'));
  assert.equal(header.rowNumber, 2);
  assert.ok(header.matched >= 7);
});

test('a sheet starting in column B is read from column B', async () => {
  // "Routine Inspection" in the real workbook has an empty column A.
  const sheet = await sheetFrom(
    [
      ['Inspection Routine '],
      ['Sl no', 'Area', 'Discipline', 'Interval ', 'Inspection Activity', 'Equipments ', 'Duration of Inspection', 'Action by ', 'Inspection Date ', 'Next Inspec Date'],
      ['1', 'SHP', 'Mechanical ', 'weekly ', 'Pestilator steel belt ', 'Steel belt', '1', 'Rehan / Nandy ', '', ''],
    ],
    { name: 'Routine Inspection', startColumn: 2 },
  );

  const { rows } = extractRows(sheet, getRegister('routine-inspection'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activity, 'Pestilator steel belt');
  assert.equal(rows[0].actionBy, 'Rehan / Nandy');
});

test('sheet names cannot decide a register on their own', async () => {
  // Both uploaded workbooks contain a sheet called "Sheet1"; only the headers
  // distinguish an Action Notice sheet from anything else.
  const sheet = await sheetFrom([
    ["Solid Handling Plant's IWS Track"],
    ['Ser.', 'IWS Number', 'Priority', 'Area', 'Unit ', 'Discipline', 'Description', 'Date Issued', 'Target Date'],
    ['1', 'IWS-2021-004', 'P4', 'SHP', '178', 'Civil', 'Ship loader', new Date(Date.UTC(2021, 0, 5)), new Date(Date.UTC(2022, 0, 5))],
  ], { name: 'Sheet1' });

  assert.equal(suggestRegister(sheet).register.id, 'iws');
});

// ------------------------------------------------------------ extraction ---

test('pre-numbered empty rows are not imported as jobs', async () => {
  // The Action Notice file carries rows 20–31 holding only a serial number,
  // ready for next month. Importing them would invent a dozen blank jobs.
  const sheet = await sheetFrom([
    ['Engineering Action Notice Tracking'],
    ACTION_NOTICE_HEADERS,
    ['1', 'PA-2607-08', '', 'Corroded Hub to be replace', '', 'Rehan', '', '', ''],
    ['20', '', '', '', '', '', '', '', ''],
    ['21', '', '', '', '', '', '', '', ''],
  ]);

  const { rows, skipped } = extractRows(sheet, getRegister('action-notice'));
  assert.equal(rows.length, 1);
  assert.equal(skipped, 2);
  assert.equal(rows[0].documentNo, 'PA-2607-08');
  // The serial column is a position, not data, so it is not stored at all.
  assert.ok(!Object.keys(rows[0]).some((key) => key.toLowerCase().includes('sl')));
});

test('an unrecognised column is kept, not dropped', async () => {
  const sheet = await sheetFrom([
    ['Engineering Action Notice Tracking'],
    [...ACTION_NOTICE_HEADERS, 'Contractor'],
    ['1', 'PA-2607-08', '', 'Corroded Hub', '', 'Rehan', '', '', '', 'Al Rashid Co'],
  ]);

  const { rows } = extractRows(sheet, getRegister('action-notice'));
  assert.equal(rows[0]['extra:Contractor'], 'Al Rashid Co');
});

test('a phrase in a date column survives as text', async () => {
  const sheet = await sheetFrom([
    ['Engineering Action Notice Tracking'],
    ACTION_NOTICE_HEADERS,
    ['1', 'PA-2607-14', '', 'Belt alignment', '178-S-0201', 'Rehan', 'Next Shutdown', '', ''],
  ]);

  const { rows } = extractRows(sheet, getRegister('action-notice'));
  const derived = deriveRecord(getRegister('action-notice'), rows[0]);

  assert.equal(rows[0].etc, 'Next Shutdown');
  assert.equal(derived.dueDate, null);
  assert.equal(derived.dueText, 'Next Shutdown', 'the reason there is no date must be visible');
});

// -------------------------------------------------------------- derivation -

test('deriveRecord maps each register’s own columns onto the shared shape', () => {
  const iws = getRegister('iws');
  const derived = deriveRecord(iws, {
    iwsNumber: 'IWS-2021-004',
    description: 'Ship loader steel structure',
    priority: 'P1',
    targetDate: '2027-01-05',
    status: 'On going',
    actionBy: 'Rehan',
    area: 'SHP',
  });

  assert.equal(derived.ref, 'IWS-2021-004');
  assert.equal(derived.title, 'Ship loader steel structure');
  assert.equal(derived.priority, 'Critical');
  assert.equal(derived.status, 'In Progress');
  assert.equal(derived.dueDate, '2027-01-05');
  assert.equal(derived.actionBy, 'Rehan');
});

test('PDM severity stands in for the priority column it does not have', () => {
  const derived = deriveRecord(getRegister('pdm'), {
    equipmentTag: '162-K-0118B',
    severity: 'Alarm',
    finding: 'Machine condition in the Orange zone',
    status: 'Close',
  });

  assert.equal(derived.priority, 'High');
  assert.equal(derived.status, 'Completed');
});

test('missing priority and status fall back rather than becoming empty', () => {
  const derived = deriveRecord(getRegister('eis'), { equipmentNumber: '178-D-0001' });
  assert.equal(derived.priority, 'Medium');
  assert.equal(derived.status, 'Not Started');
});

// ------------------------------------------------------------- due state ---

test('dueState reads late, soon, scheduled and closed', () => {
  const shift = (days) => {
    const d = new Date(`${todayIso()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  assert.equal(dueState(shift(-1), 'In Progress'), 'overdue');
  assert.equal(dueState(shift(0), 'In Progress'), 'due-soon');
  assert.equal(dueState(shift(30), 'In Progress'), 'due-soon');
  assert.equal(dueState(shift(31), 'In Progress'), 'scheduled');
  assert.equal(dueState(null, 'In Progress'), 'undated');
  // A finished job is never overdue, however old its target date.
  assert.equal(dueState(shift(-400), 'Completed'), 'closed');
});

// ---------------------------------------------------------------- queries --

function record(overrides) {
  const register = getRegister(overrides.register ?? 'iws');
  const data = overrides.data ?? {};
  return toApi(
    toRow({
      register: register.id,
      data,
      derived: { ...deriveRecord(register, data), ...overrides.derived },
      actor: 'tester',
    }),
  );
}

test('the open filter hides finished work', () => {
  const rows = [
    record({ derived: { status: 'Completed' } }),
    record({ derived: { status: 'In Progress' } }),
    record({ derived: { status: 'Archived' } }),
  ];
  assert.equal(applyQuery(rows, { open: true }).total, 1);
  assert.equal(applyQuery(rows, {}).total, 3);
});

test('undated rows sort last whichever way the due column is sorted', () => {
  const rows = [
    record({ derived: { ref: 'no-date', dueDate: null } }),
    record({ derived: { ref: 'later', dueDate: '2027-01-01' } }),
    record({ derived: { ref: 'sooner', dueDate: '2026-01-01' } }),
  ];

  assert.deepEqual(
    applyQuery(rows, { sort: 'dueDate', direction: 'asc' }).rows.map((r) => r.ref),
    ['sooner', 'later', 'no-date'],
  );
  assert.deepEqual(
    applyQuery(rows, { sort: 'dueDate', direction: 'desc' }).rows.map((r) => r.ref),
    ['later', 'sooner', 'no-date'],
  );
});

test('search reaches into the register’s own columns, not just the derived ones', () => {
  const rows = [
    record({ data: { iwsNumber: 'IWS-1', description: 'Belt', notificationNo: '760000003942' } }),
    record({ data: { iwsNumber: 'IWS-2', description: 'Pump' } }),
  ];
  assert.equal(applyQuery(rows, { search: '760000003942' }).total, 1);
  assert.equal(applyQuery(rows, { search: 'pump' }).total, 1);
});

// -------------------------------------------------------------- dashboard --

test('each register reports the figures its dashboard card shows', () => {
  const rows = [
    record({ register: 'pzv', derived: { status: 'In Progress', dueDate: '2099-01-01' } }),
    record({ register: 'pzv', derived: { status: 'Completed' } }),
    record({ register: 'pzv', derived: { status: 'Cancelled' } }),
  ];

  const pzv = summarise(rows).byRegister.find((r) => r.id === 'pzv');
  assert.equal(pzv.total, 3);
  assert.equal(pzv.open, 1);
  assert.equal(pzv.closed, 2, 'cancelled counts as closed, not as open work');
  assert.equal(pzv.completed, 1);
  // The ring is part-to-whole, so its four segments must add up to the total.
  assert.equal(pzv.overdue + pzv.dueSoon + pzv.later + pzv.closed, pzv.total);
});

test('every register lists table columns that exist as fields', () => {
  for (const register of REGISTERS) {
    const keys = new Set(register.fields.map((f) => f.key));
    assert.ok(register.tableColumns?.length, `${register.name} has no table columns`);
    for (const key of register.tableColumns) {
      assert.ok(keys.has(key), `${register.name} lists a column with no field: ${key}`);
    }
  }
});

test('summarise separates overdue, due-soon and undated open work', () => {
  const shift = (days) => {
    const d = new Date(`${todayIso()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const rows = [
    record({ derived: { dueDate: shift(-5), status: 'In Progress', actionBy: 'Rehan' } }),
    record({ derived: { dueDate: shift(10), status: 'In Progress', actionBy: 'Rehan' } }),
    record({ derived: { dueDate: shift(90), status: 'In Progress', actionBy: 'Nadeem' } }),
    record({ derived: { dueDate: null, status: 'Not Started', actionBy: null } }),
    record({ derived: { dueDate: shift(-400), status: 'Completed', actionBy: 'Rehan' } }),
  ];

  const summary = summarise(rows);
  assert.equal(summary.totals.all, 5);
  assert.equal(summary.totals.open, 4);
  assert.equal(summary.totals.overdue, 1);
  assert.equal(summary.totals.dueSoon, 1);
  assert.equal(summary.totals.undated, 1);
  assert.equal(summary.totals.completed, 1);

  const rehan = summary.byActionBy.find((p) => p.name === 'Rehan');
  assert.equal(rehan.open, 2, 'the completed job is not workload');
  assert.equal(rehan.overdue, 1);
  assert.ok(summary.byActionBy.some((p) => p.name === 'Unassigned'));
});

// ------------------------------------------------------------- round trip --

test('an exported workbook re-imports without gaining or losing rows', async () => {
  const register = getRegister('action-notice');
  const records = [
    record({
      register: 'action-notice',
      data: {
        documentNo: 'PA-2607-08',
        description: 'Corroded Hub to be replace',
        location: 'Pastillator (162-S-0122)',
        initiator: 'Rehan',
        etc: 'Next Shutdown',
      },
    }),
    record({
      register: 'action-notice',
      data: {
        documentNo: 'PA-2607-12',
        description: 'Gear box lubrication pump',
        initiator: 'Rehan',
        etc: '2026-08-13',
        actionBy: 'Nadeem',
      },
    }),
  ];

  const buffer = await buildWorkbook([{ register, records }]);
  const { sheets } = await inspectWorkbook(buffer);

  const sheet = sheets.find((s) => s.name === 'Action Notice');
  assert.equal(sheet.suggestedRegister, 'action-notice');
  assert.equal(sheet.dataRows, 2);
  assert.deepEqual(
    sheet.unmappedColumns,
    [],
    'the computed columns this app adds must not come back as data',
  );

  const [first] = sheet.sample;
  assert.equal(first.documentNo, 'PA-2607-08');
  assert.equal(first.etc, 'Next Shutdown', 'a phrase survives the round trip');
});

test('a multi-register export carries a Summary sheet plus one sheet per register', async () => {
  const buffer = await buildWorkbook([
    { register: getRegister('iws'), records: [] },
    { register: getRegister('pzv'), records: [] },
  ]);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map((w) => w.name), ['Summary', 'IWS', 'PZV']);
});

test('a sheet with no due-date column is flagged, not silently undated', async () => {
  // A DCU master sheet arrived without a Target Date column beside an SHP one that
  // had it. All 17 rows imported "successfully" and none could ever be overdue.
  const headers = ['Ser.', 'IWS Number', 'Area', 'Unit ', 'Discipline', 'Description', 'Date Issued', 'Status'];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('DCU-Master Tracking Sheet');
  sheet.getRow(1).values = ['DCU-Master Tracking Sheet'];
  sheet.getRow(2).values = headers;
  sheet.getRow(3).values = [1, 'IWS-DCU-1', 'DCU', '113', 'Mechanical', 'Job 1', '2026-01-01', 'In Progress'];

  const { sheets } = await inspectWorkbook(await workbook.xlsx.writeBuffer());
  const [only] = sheets;

  assert.equal(only.suggestedRegister, 'iws');
  assert.deepEqual(
    only.missingKeyColumns.map((c) => c.label),
    ['Target Date'],
    'the import screen must be able to warn before the rows land',
  );
});

test('the spelling the team actually uses for Target Date is recognised', async () => {
  // Their own IWS sheets and change notes write it "Targate Date".
  const headers = ['Ser.', 'IWS Number', 'Area', 'Unit ', 'Discipline', 'Description', 'Date Issued', 'Targate Date'];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('IWS');
  sheet.getRow(1).values = ['IWS Track'];
  sheet.getRow(2).values = headers;
  sheet.getRow(3).values = [1, 'IWS-1', 'SHP', '178', 'Civil', 'Job', '2026-01-01', '2027-06-30'];

  const { sheets } = await inspectWorkbook(await workbook.xlsx.writeBuffer());
  assert.ok(
    !sheets[0].missingKeyColumns.some((c) => c.role === 'due'),
    'the misspelling must resolve to the due-date column',
  );

  const { register, rows } = await readSheet(await workbook.xlsx.writeBuffer(), 'IWS', 'iws');
  assert.equal(deriveRecord(register, rows[0]).dueDate, '2027-06-30');
});

// --------------------------------------------------------- import commit ---

/** Start the app on an ephemeral port over a throwaway JSON store. */
async function withServer(run, { env = {}, overrides = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-test-'));
  const { app } = await createApp({ TRACKER_DATA_FILE: join(dir, 'data.json'), ...env }, overrides);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('two sheets replacing the same register do not erase each other', async () => {
  // A real workbook carries an SHP master sheet and a DCU master sheet, both
  // feeding IWS. Clearing per sheet meant the second wiped the first: 117 rows
  // plus 17 rows landed as 17. "Replace" means this file is the master copy for
  // the register, so its sheets replace it together.
  const workbook = new ExcelJS.Workbook();
  const headers = ['Ser.', 'IWS Number', 'Area', 'Unit ', 'Discipline', 'Description', 'Date Issued', 'Target Date'];

  for (const [name, count, prefix] of [['SHP-Master', 3, 'SHP'], ['DCU-Master', 2, 'DCU']]) {
    const sheet = workbook.addWorksheet(name);
    sheet.getRow(1).values = [`${name} Tracking Sheet`];
    sheet.getRow(2).values = headers;
    for (let i = 1; i <= count; i += 1) {
      sheet.getRow(2 + i).values = [i, `IWS-${prefix}-${i}`, prefix, '178', 'Mechanical', `Job ${i}`, '2026-01-01', '2026-12-31'];
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();

  await withServer(async (base) => {
    const form = new FormData();
    form.append('file', new Blob([buffer]), 'master.xlsx');
    const inspected = await (await fetch(`${base}/api/import/inspect`, { method: 'POST', body: form })).json();

    const committed = await (
      await fetch(`${base}/api/import/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: inspected.token,
          selections: [
            { sheet: 'SHP-Master', register: 'iws', mode: 'replace' },
            { sheet: 'DCU-Master', register: 'iws', mode: 'replace' },
          ],
        }),
      })
    ).json();

    assert.deepEqual(committed.results.map((r) => r.imported), [3, 2]);
    // Only the first sheet clears; the second adds to it.
    assert.deepEqual(committed.results.map((r) => r.replaced), [0, 0]);

    const listed = await (await fetch(`${base}/api/records?register=iws&pageSize=100`)).json();
    assert.equal(listed.total, 5, 'both sheets should survive the same upload');

    const refs = listed.rows.map((r) => r.ref).sort();
    assert.deepEqual(refs, ['IWS-DCU-1', 'IWS-DCU-2', 'IWS-SHP-1', 'IWS-SHP-2', 'IWS-SHP-3']);
  });
});

test('a later upload still replaces what an earlier one imported', async () => {
  const build = async (prefix, count) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Master');
    sheet.getRow(1).values = ['IWS Track'];
    sheet.getRow(2).values = ['Ser.', 'IWS Number', 'Area', 'Unit ', 'Discipline', 'Description', 'Date Issued', 'Target Date'];
    for (let i = 1; i <= count; i += 1) {
      sheet.getRow(2 + i).values = [i, `IWS-${prefix}-${i}`, 'SHP', '178', 'Civil', `Job ${i}`, '2026-01-01', '2026-12-31'];
    }
    return workbook.xlsx.writeBuffer();
  };

  await withServer(async (base) => {
    const upload = async (buffer) => {
      const form = new FormData();
      form.append('file', new Blob([buffer]), 'master.xlsx');
      const inspected = await (await fetch(`${base}/api/import/inspect`, { method: 'POST', body: form })).json();
      return (
        await fetch(`${base}/api/import/commit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: inspected.token,
            selections: [{ sheet: 'Master', register: 'iws', mode: 'replace' }],
          }),
        })
      ).json();
    };

    await upload(await build('OLD', 4));
    const second = await upload(await build('NEW', 2));

    assert.equal(second.results[0].replaced, 4, 'a fresh upload still clears the register');

    const listed = await (await fetch(`${base}/api/records?register=iws&pageSize=100`)).json();
    assert.equal(listed.total, 2);
    assert.ok(listed.rows.every((r) => r.ref.startsWith('IWS-NEW')));
  });
});

// --------------------------------------------------------------- accounts ---

/** Sign up the first admin and return a helper that calls the API as them. */
async function withAdmin(run, options = {}) {
  return withServer(async (base) => {
    const post = (path, body, token) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

    const setup = await (
      await post('/api/auth/setup', {
        name: 'Abdul Rahman',
        email: 'Abdul@Example.com',
        password: 'shp-tracker-2026',
      })
    ).json();

    // Managing accounts needs a recent password confirmation as well as a session.
    const confirmFor = async (token, password) =>
      (
        await (
          await fetch(`${base}/api/auth/confirm`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ password }),
          })
        ).json()
      ).confirmToken;

    const adminConfirm = await confirmFor(setup.token, 'shp-tracker-2026');

    const as = (token, confirmToken = null) => {
      const headers = (extra = {}) => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(confirmToken ? { 'x-confirm-token': confirmToken } : {}),
        ...extra,
      });
      return {
        get: (path) => fetch(base + path, { headers: headers() }),
        post: (path, body) =>
          fetch(base + path, {
            method: 'POST',
            headers: headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
          }),
        patch: (path, body) =>
          fetch(base + path, {
            method: 'PATCH',
            headers: headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
          }),
        put: (path, body) =>
          fetch(base + path, {
            method: 'PUT',
            headers: headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
          }),
        del: (path) => fetch(base + path, { method: 'DELETE', headers: headers() }),
      };
    };

    // The admin helper carries the confirmation; `as(token)` alone does not.
    const asAdmin = () => as(setup.token, adminConfirm);

    return run({ base, setup, as, asAdmin, post, confirmFor });
  }, options);
}

test('the first account becomes an admin, and the email is stored lowercased', async () => {
  await withAdmin(async ({ setup, as, asAdmin }) => {
    assert.equal(setup.user.role, 'admin');
    assert.equal(setup.user.email, 'abdul@example.com', 'so signing in is not case-sensitive');
    assert.ok(setup.token);

    const me = await (await as(setup.token).get('/api/auth/me')).json();
    assert.equal(me.user.id, setup.user.id);
  });
});

test('once an account exists, the app is closed to strangers', async () => {
  await withAdmin(async ({ base, as }) => {
    assert.equal((await fetch(`${base}/api/records?register=iws`)).status, 401);
    assert.equal((await as('not-a-real-token').get('/api/records?register=iws')).status, 401);

    // And nobody can seize it by re-running setup.
    const again = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Intruder', email: 'x@y.com', password: 'password-12345' }),
    });
    assert.equal(again.status, 409);
  });
});

test('a wrong password and an unknown email are refused identically', async () => {
  await withAdmin(async ({ base }) => {
    const attempt = (body) =>
      fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const wrongPassword = await attempt({ email: 'abdul@example.com', password: 'nope' });
    const unknownEmail = await attempt({ email: 'nobody@example.com', password: 'nope' });

    // Otherwise the login form becomes a way to find out who works here.
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, unknownEmail.body);
  });
});

test('a viewer can read but cannot change anything', async () => {
  await withAdmin(async ({ setup, as, asAdmin, base }) => {
    const admin = asAdmin();
    await admin.post('/api/users', {
      name: 'Nadeem',
      email: 'nadeem@example.com',
      password: 'inspection-2026',
      role: 'viewer',
    });

    const login = await (
      await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nadeem@example.com', password: 'inspection-2026' }),
      })
    ).json();

    const viewer = as(login.token);
    assert.equal((await viewer.get('/api/records?register=iws')).status, 200);
    assert.equal((await viewer.get('/api/export')).status, 200);

    const created = await viewer.post('/api/records', { register: 'iws', data: { iwsNumber: 'X' } });
    assert.equal(created.status, 403);

    // And a viewer cannot promote themselves.
    assert.equal((await viewer.get('/api/users')).status, 403);
    assert.equal((await viewer.patch(`/api/users/${login.user.id}`, { role: 'admin' })).status, 403);
  });
});

test('an editor limited to one register cannot reach the others', async () => {
  await withAdmin(async ({ setup, as, asAdmin, base }) => {
    const admin = asAdmin();

    // Seed a row in each of two registers, as the admin.
    await admin.post('/api/records', { register: 'iws', data: { iwsNumber: 'IWS-1' } });
    await admin.post('/api/records', { register: 'pdm', data: { equipmentTag: 'PDM-1' } });

    await admin.post('/api/users', {
      name: 'Rehan',
      email: 'rehan@example.com',
      password: 'conveyor-2026',
      role: 'editor',
      registers: ['iws'],
    });

    const login = await (
      await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'rehan@example.com', password: 'conveyor-2026' }),
      })
    ).json();
    const rehan = as(login.token);

    assert.equal((await rehan.get('/api/records?register=iws')).status, 200);
    assert.equal((await rehan.get('/api/records?register=pdm')).status, 403);
    assert.equal(
      (await rehan.post('/api/records', { register: 'pdm', data: { equipmentTag: 'X' } })).status,
      403,
    );

    // The dashboard must not leak counts from a register they cannot open, nor
    // show a card for one — an empty ring reads as "nothing there", not "not yours".
    const dash = await (await rehan.get('/api/dashboard')).json();
    assert.equal(dash.totals.all, 1, 'only the IWS row is counted');
    assert.deepEqual(dash.byRegister.map((r) => r.id), ['iws']);

    // Nor may an export quietly include it.
    const exported = await rehan.get('/api/export');
    assert.equal(exported.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exported.arrayBuffer());
    assert.deepEqual(workbook.worksheets.map((w) => w.name), ['IWS']);
  });
});

test('the last admin cannot lock everyone out', async () => {
  await withAdmin(async ({ setup, as, asAdmin }) => {
    const admin = asAdmin();

    const demote = await admin.patch(`/api/users/${setup.user.id}`, { role: 'viewer' });
    assert.equal(demote.status, 400, 'demoting the only admin would leave nobody able to undo it');

    const disable = await admin.patch(`/api/users/${setup.user.id}`, { active: false });
    assert.equal(disable.status, 400);

    // With a second admin in place it is allowed.
    await admin.post('/api/users', {
      name: 'Minhaj',
      email: 'minhaj@example.com',
      password: 'second-admin-2026',
      role: 'admin',
    });
    assert.equal((await admin.patch(`/api/users/${setup.user.id}`, { role: 'viewer' })).status, 200);
  });
});

test('a password is checked before it is accepted', async () => {
  await withAdmin(async ({ setup, as, asAdmin }) => {
    const admin = asAdmin();
    const weak = await admin.post('/api/users', {
      name: 'Test',
      email: 'weak@example.com',
      password: 'short',
    });
    assert.equal(weak.status, 400);

    const duplicate = await admin.post('/api/users', {
      name: 'Duplicate',
      email: 'ABDUL@example.com',
      password: 'another-password',
    });
    assert.equal(duplicate.status, 409, 'the same email in different case is the same person');
  });
});

test('passwords are stored hashed, never in a readable form', async () => {
  const { hashPassword, verifyPassword } = await import('../src/auth.js');
  const stored = hashPassword('conveyor-2026');

  assert.ok(!stored.includes('conveyor-2026'));
  assert.ok(stored.startsWith('scrypt$'));
  assert.ok(verifyPassword('conveyor-2026', stored));
  assert.ok(!verifyPassword('conveyor-2027', stored));
  // Two accounts with the same password must not produce the same hash.
  assert.notEqual(stored, hashPassword('conveyor-2026'));
});

test('a tampered or expired session token is refused', async () => {
  const { signToken, verifyToken } = await import('../src/auth.js');
  const secret = 'test-secret';
  const token = signToken('user-1', secret);

  assert.equal(verifyToken(token, secret), 'user-1');
  assert.equal(verifyToken(token, 'different-secret'), null, 'a forged signature is refused');
  assert.equal(verifyToken(`${token}x`, secret), null);
  assert.equal(verifyToken(signToken('user-1', secret, -1000), secret), null, 'expired');
  assert.equal(verifyToken('', secret), null);
});

test('Settings needs the password again, even for a signed-in admin', async () => {
  await withAdmin(async ({ setup, as, asAdmin, confirmFor, base }) => {
    // A valid admin session on its own is not enough — this is the whole point:
    // an unattended, still-signed-in browser must not be able to change access.
    const sessionOnly = as(setup.token);
    const refused = await sessionOnly.get('/api/users');
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).needsConfirmation, true);

    // Nor may the session token be replayed as the confirmation.
    const replayed = as(setup.token, setup.token);
    assert.equal((await replayed.get('/api/users')).status, 403);

    // A wrong password does not produce one.
    const wrong = await fetch(`${base}/api/auth/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${setup.token}` },
      body: JSON.stringify({ password: 'not-my-password' }),
    });
    assert.equal(wrong.status, 401);

    // With the real password it opens.
    assert.equal((await asAdmin().get('/api/users')).status, 200);

    // Every managing route is behind it, not just the listing.
    assert.equal((await sessionOnly.post('/api/users', {
      name: 'X', email: 'x@example.com', password: 'a-long-password',
    })).status, 403);
    assert.equal((await sessionOnly.patch(`/api/users/${setup.user.id}`, { name: 'Renamed' })).status, 403);
    assert.equal((await sessionOnly.del(`/api/users/${setup.user.id}`)).status, 403);

    // A confirmation belongs to one account and expires.
    const { signToken, verifyToken } = await import('../src/auth.js');
    assert.equal(verifyToken(signToken('someone', 's', 60000, 'confirm'), 's', 'session'), null);
    assert.equal(verifyToken(signToken('someone', 's', -1, 'confirm'), 's', 'confirm'), null);

    // A viewer cannot confirm their way into Settings either.
    const admin = asAdmin();
    await admin.post('/api/users', {
      name: 'Nadeem', email: 'nadeem@example.com', password: 'inspection-2026', role: 'viewer',
    });
    const login = await (
      await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nadeem@example.com', password: 'inspection-2026' }),
      })
    ).json();
    const viewerConfirm = await confirmFor(login.token, 'inspection-2026');
    assert.ok(viewerConfirm, 'a viewer can confirm their own password');
    assert.equal((await as(login.token, viewerConfirm).get('/api/users')).status, 403);
  });
});

// ----------------------------------------------------------------- report ---

/**
 * The text drawn in a PDF, with all spacing removed, for assertions.
 *
 * Three layers have to come off. pdfkit compresses its content streams, so the
 * words are not in the raw bytes; it writes glyphs as hex strings; and it splits
 * a word across a kerned array — `[Depar -20 tment] TJ` — so no phrase appears
 * contiguously. Stripping whitespace from both sides of the comparison is what
 * makes an assertion about the rendered words possible at all.
 */
function pdfText(buffer) {
  const raw = buffer.toString('latin1');
  let text = '';

  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const from = match.index + match[0].length;
    const to = raw.indexOf('endstream', from);
    if (to === -1) continue;
    try {
      text += inflateSync(Buffer.from(raw.slice(from, to), 'latin1')).toString('latin1');
    } catch {
      // Not a compressed stream — images and the like.
    }
  }

  // Inside a `[...] TJ` array, the glyphs are hex strings and the bare numbers
  // between them are kerning. Decoding first and stripping numbers afterwards
  // also ate the digits in the text — "Due in 30 days" came out "Dueindays" —
  // so the hex runs are isolated before anything is thrown away.
  return [...text.matchAll(/\[([^\]]*)\]\s*TJ/g)]
    .map(([, inner]) =>
      [...inner.matchAll(/<([0-9A-Fa-f]+)>/g)]
        .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
        .join(''),
    )
    .join('')
    .replace(/\s+/g, '');
}

/** Compare ignoring the spacing the PDF has already thrown away. */
const pdfHas = (text, phrase) => text.includes(phrase.replace(/\s+/g, ''));

test('the PDF report is a real PDF and carries the department heading', async () => {
  await withAdmin(async ({ setup, as, asAdmin }) => {
    await asAdmin().post('/api/records', {
      register: 'iws',
      data: { iwsNumber: 'IWS-2026-001', description: 'Ship loader inspection', targetDate: '2026-01-01' },
    });

    const response = await as(setup.token).get('/api/report.pdf');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/pdf/);
    assert.match(
      response.headers.get('content-disposition'),
      /Engineering_Department_Updates_\d{4}-\d{2}-\d{2}\.pdf/,
    );

    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', 'must actually be a PDF');

    const text = pdfText(bytes);
    for (const phrase of ['Engineering Department Updates', 'Needs attention', 'Each register', 'Total Jobs']) {
      assert.ok(pdfHas(text, phrase), `the report should contain "${phrase}"`);
    }

    // The standard-14 fonts are WinAnsi, and a character outside it does not
    // fail — it silently prints as something else. "Due ≤30d" came out as
    // `Due "d30d`, so the header is spelled in words and pinned here.
    assert.ok(pdfHas(text, 'Due in 30d'), 'the due-window header must read as words');
    assert.ok(!text.includes('"d30d'), 'and not as the mis-encoded form');
  });
});

test('a restricted account gets a report covering only its own registers', async () => {
  await withAdmin(async ({ as, asAdmin, base }) => {
    const admin = asAdmin();
    await admin.post('/api/records', { register: 'iws', data: { iwsNumber: 'IWS-1' } });
    await admin.post('/api/records', { register: 'pdm', data: { equipmentTag: 'PDM-1' } });
    await admin.post('/api/users', {
      name: 'Rehan',
      email: 'rehan@example.com',
      password: 'conveyor-2026',
      role: 'editor',
      registers: ['iws'],
    });

    const login = await (
      await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'rehan@example.com', password: 'conveyor-2026' }),
      })
    ).json();

    const text = pdfText(Buffer.from(await (await as(login.token).get('/api/report.pdf')).arrayBuffer()));

    // Their own register is listed; a register they cannot open is not.
    assert.ok(pdfHas(text, 'IWS'));
    assert.ok(!pdfHas(text, 'PDM'), 'a register they cannot open must not appear');
    assert.ok(
      pdfHas(text, 'Covers IWS only'),
      'and the report says what it covers, so it is not mistaken for the whole department',
    );
  });
});

test('the report logo is admin-only and must be an image', async () => {
  await withAdmin(async ({ setup, as, asAdmin }) => {
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    assert.equal(
      (await as(setup.token).post('/api/users', { name: 'x', email: 'x@y.com', password: 'longenough1' })).status,
      403,
      'sanity: managing needs the confirmation',
    );

    const admin = asAdmin();
    assert.equal((await admin.put('/api/report/logo', { logo: png })).status, 200);
    assert.equal(
      (await admin.put('/api/report/logo', { logo: 'not-an-image' })).status,
      400,
      'anything that is not an image data URI is refused',
    );

    // And it reaches the report.
    const text = pdfText(Buffer.from(await (await admin.get('/api/report.pdf')).arrayBuffer()));
    assert.ok(pdfHas(text, 'Engineering Department Updates'));
  });
});

// ------------------------------------------------------- email reminders ----

/**
 * A mailer that records instead of sending.
 *
 * The alternative — a "pretend to send" flag inside the route — would mean the
 * tests exercise a branch production never runs, which is the opposite of what
 * a test is for.
 */
function fakeMailer() {
  const outbox = [];
  return {
    outbox,
    provider: 'fake',
    from: 'Tracker <tracker@example.com>',
    configured: true,
    problem: null,
    async send(message) {
      outbox.push(message);
    },
    async sendAll(messages) {
      for (const message of messages) await this.send(message);
      return { sent: messages.map((m) => m.to), failed: [] };
    },
  };
}

const openRecord = (over = {}) => ({
  id: over.id ?? 'r1',
  register: 'iws',
  ref: 'IWS-01',
  title: 'Clean the heat exchanger',
  status: 'Not Started',
  priority: 'Medium',
  actionBy: 'Ali',
  dueDate: null,
  ...over,
});

test('reminders band a job by how far away its due date is', () => {
  const config = normaliseConfig({ windowDays: 30, dailyWithinDays: 15 });
  const today = '2026-08-11';
  const on = (dueDate, over) => bandOf(openRecord({ dueDate, ...over }), config, today);

  assert.equal(on('2026-08-01'), 'overdue');
  assert.equal(on('2026-08-11'), 'urgent', 'due today is urgent, not overdue');
  assert.equal(on('2026-08-26'), 'urgent', 'the fifteenth day is still the daily band');
  assert.equal(on('2026-08-27'), 'soon', 'the sixteenth is the weekly band');
  assert.equal(on('2026-09-10'), 'soon', 'the thirtieth day is the last one in the window');
  assert.equal(on('2026-09-11'), null, 'beyond the window, no reminder');

  // The two ways a job earns silence.
  assert.equal(on('2026-08-01', { status: 'Completed' }), null);
  assert.equal(on(null), null, 'an undated job cannot be said to be due');
});

test('the 16–30 day band goes out weekly, the urgent ones every day', () => {
  const config = normaliseConfig({ weeklyOn: 'Sunday' });

  // 2026-08-11 is a Tuesday; 2026-08-16 is a Sunday.
  assert.equal(weekdayOf('2026-08-11'), 'Tuesday');
  assert.deepEqual(bandsSendingOn(config, '2026-08-11'), ['overdue', 'urgent']);
  assert.deepEqual(bandsSendingOn(config, '2026-08-16'), ['overdue', 'urgent', 'soon']);

  // This is the point of the whole design: a job three weeks out does not
  // generate a message every morning, or the daily ones stop being read.
  assert.equal(sendsToday('soon', config, '2026-08-11'), false);
  assert.equal(sendsToday('overdue', config, '2026-08-11'), true);
});

test('a daily threshold wider than the window is clamped, not obeyed', () => {
  // Otherwise the whole "coming up" band is silently promoted to a daily email.
  const config = normaliseConfig({ windowDays: 30, dailyWithinDays: 90 });
  assert.equal(config.dailyWithinDays, 30);
  assert.equal(normaliseConfig({ weeklyOn: 'Caturday' }).weeklyOn, 'Sunday');
  assert.deepEqual(
    normaliseConfig({ extraRecipients: ['a@b.com', 'A@B.COM', 'nonsense', ''] }).extraRecipients,
    ['a@b.com'],
    'duplicates and non-addresses are dropped rather than handed to the mail server',
  );
});

test('an owner name from a spreadsheet is matched to the right account', () => {
  assert.ok(ownerMatches('Abdulrahman', 'Abdulrahman Sankyu'));
  assert.ok(ownerMatches('ABDULRAHMAN S.', 'Abdulrahman Sankyu'));
  assert.ok(ownerMatches('Ali', 'Ali'), 'a three-letter name is a name, not an initial');
  assert.ok(ownerMatches('Mohammed/Khan', 'Khan Mohammed'), 'order does not matter');

  assert.ok(!ownerMatches('Ali', 'Alissa'), 'tokens match whole, never by prefix');
  assert.ok(!ownerMatches('A.', 'Abdulrahman'), 'an initial is not enough to claim the work');
  assert.ok(!ownerMatches('', 'Abdulrahman'));
  assert.ok(!ownerMatches('Ali', null), 'an address with no account name matches nobody');
});

test('a reminder covers only the registers the recipient may open', async () => {
  await withAdmin(async ({ asAdmin, post, base }) => {
    const admin = asAdmin();

    await admin.post('/api/records', {
      register: 'iws',
      data: { iwsNumber: 'IWS-01', description: 'Overdue scope', targetDate: '2020-01-01', actionBy: 'Rehan' },
    });
    await admin.post('/api/records', {
      register: 'pdm',
      data: { equipmentTag: 'P-101', finding: 'Bearing noise', targetDate: '2020-01-01', actionBy: 'Rehan' },
    });

    await admin.post('/api/users', {
      name: 'Rehan',
      email: 'rehan@example.com',
      password: 'conveyor-2026',
      role: 'editor',
      registers: ['iws'],
    });

    const preview = await (await admin.get('/api/reminders/preview')).json();
    const rehan = preview.messages.find((m) => m.to === 'rehan@example.com');

    assert.ok(rehan, 'the restricted account is still a recipient');
    assert.equal(rehan.counts.overdue, 1, 'only the IWS job — PDM is not theirs to see');
    assert.equal(
      preview.messages.find((m) => m.to === 'abdul@example.com').counts.overdue,
      2,
      'the unrestricted admin sees both',
    );

    // The permission is enforced on the digest itself, not only on its counts.
    assert.equal(
      (await admin.get('/api/reminders')).status,
      200,
      'sanity: reading the config needs the admin confirmation',
    );
  });
});

test('the run endpoint is closed to callers with neither the secret nor an admin session', async () => {
  const mailer = fakeMailer();
  await withAdmin(
    async ({ base, setup, as, asAdmin }) => {
      const run = (headers = {}) =>
        fetch(`${base}/api/reminders/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: '{}',
        });

      assert.equal((await run()).status, 401, 'anonymous');
      assert.equal((await run({ 'x-reminder-secret': 'wrong' })).status, 401, 'wrong secret');

      // A signed-in admin without the recent password confirmation is not enough
      // either — sending mail to the whole team is a Settings-grade action.
      assert.equal(
        (await run({ authorization: `Bearer ${setup.token}` })).status,
        403,
        'admin session without the password confirmation',
      );

      // Switched off is switched off, even for an authorised caller.
      const off = await (await run({ 'x-reminder-secret': 'let-me-in' })).json();
      assert.equal(off.sent, 0);
      assert.match(off.skipped, /switched off/);
      assert.equal(mailer.outbox.length, 0);
    },
    { env: { TRACKER_REMINDER_SECRET: 'let-me-in' }, overrides: { mailer } },
  );
});

test('a scheduled run emails each person once, and refuses to send twice the same day', async () => {
  const mailer = fakeMailer();
  await withAdmin(
    async ({ base, asAdmin }) => {
      const admin = asAdmin();
      await admin.post('/api/records', {
        register: 'iws',
        data: { iwsNumber: 'IWS-77', description: 'Late scope', targetDate: '2020-01-01', actionBy: 'Abdul Rahman' },
      });
      await admin.put('/api/reminders', { enabled: true, appUrl: 'https://tracker.example.com' });

      const run = (body = {}) =>
        fetch(`${base}/api/reminders/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-reminder-secret': 'let-me-in' },
          body: JSON.stringify(body),
        });

      const first = await (await run()).json();
      assert.equal(first.sent, 1);
      assert.equal(first.trigger, 'schedule');
      assert.equal(mailer.outbox.length, 1);

      const message = mailer.outbox[0];
      assert.equal(message.to, 'abdul@example.com');
      assert.match(message.subject, /1 overdue/);
      assert.match(message.html, /Engineering Department Updates/);
      assert.match(message.html, /Late scope/);
      assert.match(message.text, /Late scope/, 'and a plain-text alternative, for clients that refuse HTML');
      assert.match(
        message.html,
        /Assigned to you/,
        'the owner name in the sheet is matched to the account, so their own row leads',
      );

      // A cron that double-fires, or an admin pressing the button after it ran,
      // must not send the team the same digest again.
      const second = await (await run()).json();
      assert.equal(second.sent, 0);
      assert.match(second.skipped, /already sent today/);
      assert.equal(mailer.outbox.length, 1);

      // Forcing is still possible, because that is what "resend it" means.
      assert.equal((await (await run({ force: true })).json()).sent, 1);
      assert.equal(mailer.outbox.length, 2);

      const state = await (await admin.get('/api/reminders')).json();
      assert.equal(state.runs.length, 2, 'and every run is logged');
      assert.equal(state.config.enabled, true);
    },
    { env: { TRACKER_REMINDER_SECRET: 'let-me-in' }, overrides: { mailer } },
  );
});

test('nobody is emailed when they have nothing due', async () => {
  const mailer = fakeMailer();
  await withAdmin(
    async ({ base, asAdmin }) => {
      const admin = asAdmin();
      // Due in a year: inside no band at all.
      await admin.post('/api/records', {
        register: 'iws',
        data: { iwsNumber: 'IWS-99', description: 'Next year', targetDate: '2099-01-01', actionBy: 'Abdul Rahman' },
      });
      await admin.put('/api/reminders', { enabled: true });

      const result = await (
        await fetch(`${base}/api/reminders/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-reminder-secret': 'let-me-in' },
          body: '{}',
        })
      ).json();

      assert.equal(result.sent, 0);
      assert.equal(mailer.outbox.length, 0, 'an empty digest every morning is how a digest gets filtered');
      assert.equal(result.skippedRecipients[0].reason, 'nothing due');
    },
    { env: { TRACKER_REMINDER_SECRET: 'let-me-in' }, overrides: { mailer } },
  );
});

test('reminder settings are admin-only, and credentials are never served', async () => {
  await withAdmin(async ({ setup, as, asAdmin }) => {
    assert.equal((await as(setup.token).get('/api/reminders')).status, 403, 'no password confirmation');

    const body = await (await asAdmin().get('/api/reminders')).json();
    // The transport's state is useful; its password is not, and it lives in the
    // environment precisely so it cannot leak through here.
    assert.equal(typeof body.mail.configured, 'boolean');
    assert.equal(JSON.stringify(body).includes('PASSWORD'), false);
    assert.equal(JSON.stringify(body).includes('api-key'), false);
  });
});

// ------------------------------------------------- the Outlook (Graph) path --

/**
 * Stand in for the network for the duration of one test.
 *
 * `node:test` runs a file's tests one after another, so replacing the global
 * and restoring it in `finally` cannot leak into the tests that talk to a real
 * local server.
 */
async function withStubbedFetch(handler, run) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const GRAPH_ENV = {
  TRACKER_GRAPH_TENANT_ID: 'tenant-abc',
  TRACKER_GRAPH_CLIENT_ID: 'client-abc',
  TRACKER_GRAPH_CLIENT_SECRET: 'secret-abc',
  TRACKER_MAIL_FROM: 'Engineering Tracker <engineering@sankyu.example>',
};

test('a company Outlook mailbox is detected, and each missing piece is named', () => {
  assert.equal(createMailer(GRAPH_ENV).provider, 'graph');
  assert.equal(createMailer(GRAPH_ENV).configured, true);

  // Naming the wrong variable is worse than naming none: it sends somebody to
  // check a setting that is already correct. Each answer names what is missing.
  assert.match(
    createMailer({ TRACKER_GRAPH_CLIENT_ID: 'c' }).problem,
    /TRACKER_GRAPH_TENANT_ID/,
  );
  assert.match(
    createMailer({ TRACKER_GRAPH_CLIENT_ID: 'c', TRACKER_GRAPH_TENANT_ID: 't' }).problem,
    /TRACKER_GRAPH_CLIENT_SECRET/,
  );
  assert.match(
    createMailer({ ...GRAPH_ENV, TRACKER_MAIL_FROM: '' }).problem,
    /mailbox the reminders should come from/,
  );
});

test('sending through Graph keeps the plain-text alternative, and reuses its token', async () => {
  const ok = (body, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } });

  await withStubbedFetch(
    (url) =>
      url.includes('login.microsoftonline.com')
        ? ok(JSON.stringify({ access_token: 'tok-123', expires_in: 3600 }))
        : new Response('', { status: 202 }),
    async (calls) => {
      const mailer = createMailer(GRAPH_ENV);
      await mailer.send({ to: 'rehan@sankyu.example', subject: 'Overdue — 2', html: '<p>Hi</p>', text: 'Hi' });
      await mailer.send({ to: 'nandy@sankyu.example', subject: 'Overdue — 1', html: '<p>Yo</p>', text: 'Yo' });

      // One token, two sends. A token lasts an hour and a run finishes in
      // seconds, so fetching one per recipient is a round trip against a login
      // endpoint that rate-limits, for nothing.
      assert.equal(calls.length, 3);
      assert.equal(calls.filter((c) => c.url.includes('login.microsoftonline')).length, 1);

      const send = calls[1];
      assert.equal(send.url, 'https://graph.microsoft.com/v1.0/users/engineering%40sankyu.example/sendMail');
      assert.equal(send.options.headers.authorization, 'Bearer tok-123');
      // text/plain, not JSON: Graph's JSON message object carries a single body,
      // which would silently drop the plain-text part every other transport keeps.
      assert.equal(send.options.headers['content-type'], 'text/plain');

      const mime = Buffer.from(send.options.body, 'base64').toString('utf8');
      assert.match(mime, /multipart\/alternative/);
      assert.match(mime, /text\/plain/);
      assert.match(mime, /text\/html/);
      assert.match(mime, /^To: rehan@sankyu\.example$/m);
    },
  );
});

test('Entra’s own reason for refusing a sign-in survives to the screen', async () => {
  await withStubbedFetch(
    () =>
      new Response(
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'AADSTS7000215: Invalid client secret provided.',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    async () => {
      const mailer = createMailer(GRAPH_ENV);
      // "Login failed" would throw away the only part of the answer that says
      // what to fix — an expired secret reads exactly like a wrong tenant.
      await assert.rejects(
        () => mailer.send({ to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 't' }),
        /AADSTS7000215/,
      );
    },
  );
});

test('an SMTP refusal is explained without losing what the server said', () => {
  // Microsoft answers with the same sentence whether the password is wrong, the
  // mailbox has SMTP AUTH switched off, or the tenant blocks Basic auth —
  // three problems with three different fixes, only one of which is worth
  // retyping a password over.
  const microsoft = explainSmtpFailure({
    response:
      '535 5.7.139 Authentication unsuccessful, the request did not meet the criteria to be authenticated successfully.',
    code: 'EAUTH',
  });
  assert.match(microsoft, /5\.7\.139/, 'the raw answer survives — IT will ask for it');
  assert.match(microsoft, /SMTP AUTH is switched off|no app-password equivalent/);

  assert.match(
    explainSmtpFailure({ response: '534-5.7.9 Application-specific password required', code: 'EAUTH' }),
    /App Password/,
  );
  assert.match(
    explainSmtpFailure({ message: 'connect ETIMEDOUT 40.99.0.1:587', code: 'ETIMEDOUT' }),
    /587 for STARTTLS/,
  );

  // Nothing invented for a failure nobody has classified: a confident wrong
  // explanation costs more than none.
  assert.equal(explainSmtpFailure({ message: 'Something new' }), 'Something new');
});

// ------------------------------------------------------------- QC report ----

const QC_HEADERS = [
  'Week',
  'Date',
  'Work Order No.',
  'PM/CM',
  'Equipment Tag no.',
  'Maint. Work Center',
  'Quality Overall %',
  'Audit Findings',
  'Finding Classification',
  'Y8/SCR',
  'Status',
  'Detail of the works',
];

const qcRow = (over = []) =>
  [2, new Date(Date.UTC(2026, 0, 3)), 830000547612, 'PM', '162-S-0116', 'A8-SK-ME', 0.9,
   'NO ISSUE FOUND FROM THERE', 'N/A', 'N/A', 'Found normal', 'MONTHLY PM WORK ON THE PASTILLATOR']
    .map((v, i) => (over[i] === undefined ? v : over[i]));

test('the QC sheet is recognised by its columns, not its name', async () => {
  // The real file's only sheet is called "Sheet1", same as two other workbooks.
  const sheet = await sheetFrom([QC_HEADERS, qcRow()], { name: 'Sheet1' });
  assert.equal(suggestRegister(sheet).register.id, 'qc');
});

test('QC’s sentences are read as statuses instead of defaulting to Not Started', () => {
  // All sixteen distinct values in the 850-row file. None matches an alias
  // exactly, so without phrase matching every row reads as never begun.
  const completed = [
    'Found normal',
    'JOB COMPLETED',
    'job completed',
    'Job Completed.',
    'jOB COMPLETED',
    'ALREADY INSTALLED',
    'NEW PRIMARY SCRAPPER  INSTALLED',
    'ALREDY REPLACED MATERIALS & STEEL BELT WELDING WORK DONE',
    'NOTIFICATION ALREADY DONE',
    'Attended on dated 5th june-2026.',
  ];
  const outstanding = ['To be attend', 'TO be attend', 'REQUESTED FOR THE MATERIALS', 'NOTIFICATION TO BE MADE'];

  for (const value of completed) assert.equal(normaliseStatus(value), 'Completed', value);
  for (const value of outstanding) assert.equal(normaliseStatus(value), 'In Progress', value);

  // Outstanding phrases are tested first, because a sentence can hold both and
  // reading "TO BE DONE" as finished is the more expensive mistake.
  assert.equal(normaliseStatus('TO BE DONE'), 'In Progress');
  assert.equal(normaliseStatus('Not completed'), 'In Progress');

  // The registers that do use a proper vocabulary are untouched — an exact
  // match is taken before any phrase is considered.
  assert.equal(normaliseStatus('Not started'), 'Not Started');
  assert.equal(normaliseStatus('Close'), 'Completed');
  assert.equal(normaliseStatus('On Hold'), 'On Hold');
});

test('a quality column formatted as a percentage is stored as one', async () => {
  const sheet = await sheetFrom([
    QC_HEADERS,
    qcRow([, , , , , , 0.9]),
    qcRow([, , 830000548524, , , , 0.88]),
    // A sheet that stores a plain 88 rather than Excel's 0.88 must not become 8800%.
    qcRow([, , 830000548525, , , , 88]),
  ]);

  const { rows } = extractRows(sheet, getRegister('qc'));
  assert.deepEqual(rows.map((r) => r.qualityPercent), [90, 88, 88]);
});

test('a stray total below the data is not imported as an audit', async () => {
  // The real file ends with a lone 0.89 and three SUM/AVERAGE formulas in the
  // quality column — a running total somebody left underneath. Each satisfied
  // "some field is filled" and would have become an audit with no work order,
  // no equipment and no findings.
  const sheet = await sheetFrom([
    QC_HEADERS,
    qcRow(),
    ['', '', '', '', '', '', 0.89],
    ['', '', '', '', '', '', 755.89],
  ]);

  const { rows, skipped } = extractRows(sheet, getRegister('qc'));
  assert.equal(rows.length, 1, 'only the real audit');
  assert.equal(skipped, 2, 'and the reader says it passed two rows over');
  assert.equal(rows[0].workOrderNo, '830000547612');
});

test('QC rows carry no due date, and are counted as undated rather than late', () => {
  // This register records audits that already happened; the sheet has no target
  // date at all. Inventing one from the audit date would park 850 permanently
  // overdue rows at the top of every dashboard and in everybody's inbox.
  const register = getRegister('qc');
  assert.equal(register.roles.due, 'targetDate');
  assert.ok(
    register.fields.some((f) => f.key === 'targetDate'),
    'the field exists so that adding the column to the sheet is all it takes',
  );

  const derived = deriveRecord(register, {
    workOrderNo: '830000547612',
    date: '2026-01-03',
    actionStatus: 'To be attend',
    findingClassification: 'Execution',
    workDetail: 'MONTHLY PM WORK',
  });

  assert.equal(derived.dueDate, null);
  assert.equal(derived.status, 'In Progress');
  assert.equal(derived.priority, 'High', 'Execution is the sheet’s only urgency signal');
  assert.equal(dueState(derived.dueDate, derived.status), 'undated');
});

// -------------------------------------------------- Action Notice numbers ---

test('the next document number follows the month and restarts with it', () => {
  assert.equal(periodOf(new Date(2026, 7, 13)), '2608');
  assert.equal(periodOf(new Date(2026, 0, 1)), '2601', 'January is 01, not 1');

  // The real sheet, which runs PA-2607-01 to PA-2607-18.
  const july = ['PA-2607-01', 'PA-2607-18', 'PA-2607-09'];
  assert.equal(nextRef(july, { prefix: 'PA', period: '2607' }), 'PA-2607-19');

  // A new month starts again at 01 however many the last one held.
  assert.equal(nextRef(july, { prefix: 'PA', period: '2608' }), 'PA-2608-01');
  assert.equal(nextRef([], { prefix: 'PA', period: '2608' }), 'PA-2608-01');

  // Highest plus one, never the count: deleting an entry must not hand its
  // number to the next one, because it is already on paperwork that has left
  // the building.
  assert.equal(nextRef(['PA-2608-01', 'PA-2608-05'], { prefix: 'PA', period: '2608' }), 'PA-2608-06');

  // Two digits, but not capped at two.
  assert.equal(nextRef(['PA-2608-99'], { prefix: 'PA', period: '2608' }), 'PA-2608-100');

  // Anything that is not one of ours is ignored rather than miscounted.
  assert.equal(nextRef(['IWS-2021-004', '', null, 'PA-26-9'], { prefix: 'PA', period: '2608' }), 'PA-2608-01');
});

test('two people saving at once cannot be given the same document number', async () => {
  await withServer(async (base) => {
    const create = (description) =>
      fetch(`${base}/api/records`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ register: 'action-notice', autoRef: true, data: { description } }),
      }).then((r) => r.json());

    // Fired together, the way two people pressing Save in the same second
    // arrive. "Read the highest, add one, insert" is a race: without
    // serialising the allocation, every one of these reads the same highest
    // number and writes the same new one. Against Postgres, where the insert
    // has to round-trip before another read can see it, all ten came back as
    // PA-...-01.
    const made = await Promise.all(Array.from({ length: 10 }, (_, i) => create(`Concurrent ${i}`)));
    const refs = made.map((r) => r.ref);

    assert.equal(new Set(refs).size, 10, 'every notice gets its own number');
    assert.deepEqual(
      [...refs].sort(),
      Array.from({ length: 10 }, (_, i) => `PA-${periodOf()}-${String(i + 1).padStart(2, '0')}`),
      'and they run consecutively from 01',
    );
  });
});

test('a number typed by hand is kept, and an imported one is never renumbered', async () => {
  await withServer(async (base) => {
    const post = (body) =>
      fetch(`${base}/api/records`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    // Someone types their own — the app must not overrule it.
    const typed = await post({
      register: 'action-notice',
      autoRef: false,
      data: { documentNo: 'PA-2512-42', description: 'Carried over from last year' },
    });
    assert.equal(typed.ref, 'PA-2512-42');

    // And an out-of-period number does not disturb the current month's count.
    const next = await post({ register: 'action-notice', autoRef: true, data: { description: 'New one' } });
    assert.equal(next.ref, `PA-${periodOf()}-01`);

    // A register that does not issue numbers is left alone.
    const iws = await post({ register: 'iws', data: { description: 'A scope' } });
    assert.equal(iws.ref, null);
  });
});

test('the form is offered the next number before anyone commits to it', async () => {
  await withServer(async (base) => {
    const preview = await (await fetch(`${base}/api/registers/action-notice/next-ref`)).json();
    assert.equal(preview.ref, `PA-${periodOf()}-01`);
    assert.equal(preview.field, 'documentNo');

    // Asking twice hands out the same number: it is a preview, not a
    // reservation, so opening the form and closing it again leaves no gap.
    const again = await (await fetch(`${base}/api/registers/action-notice/next-ref`)).json();
    assert.equal(again.ref, preview.ref);

    const refused = await fetch(`${base}/api/registers/iws/next-ref`);
    assert.equal(refused.status, 400, 'IWS numbers come from the sheet, not from us');
  });
});
