/**
 * Tests for the parts that would fail silently.
 *
 * The risk in this app is not a crash — it is a workbook that imports "cleanly"
 * while quietly dropping a column, mis-reading a date, or turning twelve blank
 * rows into twelve jobs. Each test below pins one of those.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import ExcelJS from 'exceljs';

import {
  buildWorkbook,
  detectHeader,
  extractRows,
  inspectWorkbook,
  suggestRegister,
} from '../src/excel.js';
import {
  deriveRecord,
  dueState,
  getRegister,
  normalisePriority,
  normaliseStatus,
  toDateOnly,
  todayIso,
} from '../src/registers.js';
import { summarise } from '../src/server.js';
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
