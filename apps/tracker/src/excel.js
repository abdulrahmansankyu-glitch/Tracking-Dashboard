/**
 * Reading and writing the team's workbooks.
 *
 * The uploaded files are real working spreadsheets, not exports, so the reader is
 * built around what they actually contain rather than an idealised table:
 *
 *  * Row 1 is a merged banner ("Solid Handling Plant's IWS Track"); the real header
 *    is row 2. The header row is found by matching, not assumed.
 *  * "Routine Inspection" starts in column B, so column positions are discovered
 *    rather than counted from 1.
 *  * Header wording drifts between files ("Action By " with a trailing space,
 *    "Refrence", "Plan date for callibration"), so matching ignores case, spacing
 *    and punctuation, and every field carries the spellings seen in the wild.
 *  * A column the app does not recognise is preserved as an extra field instead of
 *    being dropped — losing a column on import is worse than carrying one it has
 *    no opinion about.
 */

import ExcelJS from 'exceljs';

import {
  CLOSED_STATUSES,
  REGISTERS,
  daysUntil,
  deriveRecord,
  dueState,
  getRegister,
  normaliseKey,
  toDateOnly,
} from './registers.js';

/** How many leading rows to consider when hunting for the header. */
const HEADER_SEARCH_ROWS = 10;

/** Below this many recognised columns, a row is not a header. */
const MIN_HEADER_MATCHES = 3;

/**
 * Row-number columns, dropped rather than stored.
 *
 * Every sheet opens with one and spells it differently ("Sl no", "Ser.", "SL.NO",
 * "S.", "sl"). It is a position, not data: it renumbers itself whenever rows are
 * sorted or inserted, so keeping it would preserve a value that is wrong as soon
 * as anyone filters. Ignoring it also fixes row detection — the Action Notice
 * sheet carries a dozen pre-numbered empty rows waiting for next month's entries,
 * and a serial alone must not make a row count as data.
 */
const SERIAL_HEADERS = new Set(['slno', 'sl', 'sno', 'srno', 'sr', 'ser', 'serial', 's', 'no', 'item']);

/**
 * Columns this app adds on export, ignored when reading.
 *
 * Exporting and re-importing is a normal round trip here — someone downloads the
 * master file, edits it offline, uploads it back. Without this, each pass would
 * bolt another copy of the app's own computed columns onto every row.
 */
const COMPUTED_HEADERS = new Set([
  'trackerpriority',
  'trackerstatus',
  'trackerduedate',
  'daystodue',
  'duestate',
  'lastupdated',
  'updatedby',
]);

/** Every spelling that resolves to a field, for one register. */
function aliasIndex(register) {
  const index = new Map();
  for (const field of register.fields) {
    const spellings = [field.key, field.label, ...(field.aliases ?? [])];
    for (const spelling of spellings) {
      const key = normaliseKey(spelling);
      if (key && !index.has(key)) index.set(key, field.key);
    }
  }
  return index;
}

const ALIAS_INDEXES = new Map(REGISTERS.map((r) => [r.id, aliasIndex(r)]));

/**
 * Flatten an ExcelJS cell to plain text.
 *
 * Cells in these files arrive as rich text runs, formula wrappers and hyperlink
 * objects as well as primitives; `String(value)` on any of those yields
 * "[object Object]".
 */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text ?? '').join('');
    if ('text' in value) return String(value.text ?? '');
    if ('result' in value) return cellText(value.result);
    if ('hyperlink' in value) return String(value.hyperlink ?? '');
    if ('error' in value) return '';
    return '';
  }
  return value;
}

function asTrimmedString(value) {
  const flat = cellText(value);
  if (flat instanceof Date) return flat;
  return typeof flat === 'string' ? flat.trim() : flat;
}

/**
 * Find the header row for `register` in `worksheet`, and which column holds which
 * field. Returns null when the sheet does not look like this register at all.
 */
export function detectHeader(worksheet, register) {
  const index = ALIAS_INDEXES.get(register.id);
  let best = null;

  const limit = Math.min(worksheet.rowCount || HEADER_SEARCH_ROWS, HEADER_SEARCH_ROWS);
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (!row || !row.cellCount) continue;

    const columnMap = new Map();
    const unmapped = [];
    const seen = new Set();

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const header = asTrimmedString(cell.value);
      const label = header instanceof Date ? '' : String(header ?? '').trim();
      if (!label) return;

      const key = normaliseKey(label);
      if (SERIAL_HEADERS.has(key) || COMPUTED_HEADERS.has(key)) return;

      const field = index.get(key);
      // A repeated header (some sheets duplicate "Status") maps once; the second
      // occurrence is kept as an extra column rather than silently overwriting.
      if (field && !seen.has(field)) {
        seen.add(field);
        columnMap.set(colNumber, { field, label, extra: false });
      } else {
        unmapped.push({ colNumber, label });
      }
    });

    const matched = columnMap.size;
    if (matched >= MIN_HEADER_MATCHES && (!best || matched > best.matched)) {
      best = { rowNumber, columnMap, unmapped, matched };
    }
  }

  return best;
}

/** Rank every register against a sheet and return the closest fit. */
export function suggestRegister(worksheet) {
  const sheetKey = normaliseKey(worksheet.name);
  let best = null;

  for (const register of REGISTERS) {
    const header = detectHeader(worksheet, register);
    if (!header) continue;

    // Sheet-name agreement is a tiebreaker only, never a contribution to the
    // score. Both uploaded workbooks contain a sheet literally called "Sheet1",
    // and a name that happens to match must not outrank a register whose columns
    // genuinely fit better — weighting the name instead of ranking after it let a
    // truncated IWS sheet named "Sheet1" resolve to Action Notice.
    const nameMatch = register.sheetAliases.some((alias) => normaliseKey(alias) === sheetKey);

    const better =
      !best ||
      header.matched > best.header.matched ||
      (header.matched === best.header.matched && nameMatch && !best.nameMatch);

    if (better) best = { register, header, score: header.matched, nameMatch };
  }

  return best;
}

/** Describe every sheet in a workbook so the user can confirm the mapping. */
export async function inspectWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheets = [];
  workbook.eachSheet((worksheet) => {
    const suggestion = suggestRegister(worksheet);

    if (!suggestion) {
      sheets.push({
        name: worksheet.name,
        rowCount: worksheet.rowCount ?? 0,
        suggestedRegister: null,
        headerRow: null,
        headers: [],
        mappedColumns: [],
        unmappedColumns: [],
        dataRows: 0,
        sample: [],
      });
      return;
    }

    const { register, header } = suggestion;
    const extracted = extractRows(worksheet, register, header);

    sheets.push({
      name: worksheet.name,
      rowCount: worksheet.rowCount ?? 0,
      suggestedRegister: register.id,
      suggestedRegisterName: register.name,
      confidence: header.matched,
      headerRow: header.rowNumber,
      headers: [...header.columnMap.values()].map((c) => c.label),
      mappedColumns: [...header.columnMap.values()].map((c) => ({ label: c.label, field: c.field })),
      unmappedColumns: header.unmapped.map((c) => c.label),
      dataRows: extracted.rows.length,
      skippedRows: extracted.skipped,
      sample: extracted.rows.slice(0, 3),
    });
  });

  return { sheets };
}

/**
 * Pull data rows out of a worksheet.
 *
 * Blank rows are common in these files — the Action Notice sheet carries pre-numbered
 * empty rows 20–31 ready for next month's entries. A row counts as data only if a
 * field other than the serial number holds something.
 */
export function extractRows(worksheet, register, header = null) {
  const detected = header ?? detectHeader(worksheet, register);
  if (!detected) return { rows: [], skipped: 0, issues: [] };

  const fieldTypes = new Map(register.fields.map((f) => [f.key, f.type]));
  const rows = [];
  const issues = [];
  let skipped = 0;

  const lastRow = worksheet.rowCount ?? 0;
  for (let rowNumber = detected.rowNumber + 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (!row || !row.cellCount) {
      skipped += 1;
      continue;
    }

    const data = {};
    let hasValue = false;

    for (const [colNumber, column] of detected.columnMap) {
      const raw = asTrimmedString(row.getCell(colNumber).value);
      if (raw === '' || raw === null || raw === undefined) continue;

      const type = fieldTypes.get(column.field);
      let value;

      if (type === 'date') {
        // A date column holding "Next Shutdown" keeps the phrase; the derived due
        // date simply stays empty rather than the note being thrown away.
        value = toDateOnly(raw) ?? (raw instanceof Date ? null : String(raw));
      } else if (type === 'number') {
        const n = Number(raw);
        value = Number.isFinite(n) ? n : String(raw);
      } else if (raw instanceof Date) {
        value = toDateOnly(raw) ?? raw.toISOString().slice(0, 10);
      } else {
        value = String(raw);
      }

      if (value === null || value === '') continue;
      data[column.field] = value;
      hasValue = true;
    }

    // Unrecognised columns ride along under their sheet heading.
    for (const { colNumber, label } of detected.unmapped) {
      const raw = asTrimmedString(row.getCell(colNumber).value);
      if (raw === '' || raw === null || raw === undefined) continue;
      const value = raw instanceof Date ? toDateOnly(raw) ?? String(raw) : String(raw);
      if (!value) continue;
      data[`extra:${label}`] = value;
      hasValue = true;
    }

    if (!hasValue) {
      skipped += 1;
      continue;
    }

    rows.push(data);
  }

  return { rows, skipped, issues };
}

/** Load a workbook and return the rows for one sheet, mapped to one register. */
export async function readSheet(buffer, sheetName, registerId) {
  const register = getRegister(registerId);
  if (!register) throw new Error(`Unknown register: ${registerId}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) throw new Error(`Sheet not found: ${sheetName}`);

  return { register, ...extractRows(worksheet, register) };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

/**
 * Columns appended after the register's own, carrying what the app worked out.
 *
 * Named so they cannot collide with any header the reader recognises — a workbook
 * exported from here re-imports cleanly, and these columns are ignored on the way
 * back in rather than fighting the originals.
 */
const COMPUTED_COLUMNS = [
  { header: 'Tracker Priority', width: 14, value: (r) => r.priority },
  { header: 'Tracker Status', width: 14, value: (r) => r.status },
  { header: 'Tracker Due Date', width: 14, value: (r) => r.dueDate ?? '' },
  {
    header: 'Days To Due',
    width: 12,
    value: (r) => (r.dueDate && !CLOSED_STATUSES.has(r.status) ? daysUntil(r.dueDate) : ''),
  },
  { header: 'Due State', width: 12, value: (r) => dueState(r.dueDate, r.status) },
  { header: 'Last Updated', width: 18, value: (r) => (r.updatedAt ?? '').slice(0, 16).replace('T', ' ') },
  { header: 'Updated By', width: 16, value: (r) => r.updatedBy ?? '' },
];

function widthFor(field) {
  if (field.type === 'longtext') return 46;
  if (field.type === 'date') return 14;
  if (field.type === 'number') return 12;
  return 20;
}

function writeRegisterSheet(workbook, register, records) {
  const sheet = workbook.addWorksheet(register.name, {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  // Row 1 repeats the banner the team's own files carry, so an exported workbook
  // looks like the one it replaces.
  sheet.mergeCells(1, 1, 1, register.fields.length + COMPUTED_COLUMNS.length + 1);
  const banner = sheet.getCell(1, 1);
  banner.value = `${register.name} — ${register.description}`;
  banner.font = { bold: true, size: 13 };
  banner.alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 22;

  const headers = ['Sl no', ...register.fields.map((f) => f.label), ...COMPUTED_COLUMNS.map((c) => c.header)];
  const headerRow = sheet.getRow(2);
  headerRow.values = headers;
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });

  sheet.columns = [
    { width: 7 },
    ...register.fields.map((f) => ({ width: widthFor(f) })),
    ...COMPUTED_COLUMNS.map((c) => ({ width: c.width })),
  ];

  records.forEach((record, i) => {
    const values = [
      i + 1,
      ...register.fields.map((f) => {
        const value = record.data?.[f.key];
        return value === undefined || value === null ? '' : value;
      }),
      ...COMPUTED_COLUMNS.map((c) => c.value(record)),
    ];
    const row = sheet.addRow(values);
    row.alignment = { vertical: 'top', wrapText: true };

    // Overdue rows are tinted so the state is visible in Excel too, not only in the app.
    const state = dueState(record.dueDate, record.status);
    if (state === 'overdue') {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7E9' } };
      });
    } else if (state === 'due-soon') {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF6E5' } };
      });
    }
  });

  if (records.length) {
    sheet.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: 2 + records.length, column: headers.length },
    };
  }

  return sheet;
}

function writeSummarySheet(workbook, groups) {
  const sheet = workbook.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 2 }] });

  sheet.mergeCells(1, 1, 1, 7);
  const banner = sheet.getCell(1, 1);
  banner.value = `Engineering Activity Tracker — exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  banner.font = { bold: true, size: 13 };

  const headerRow = sheet.getRow(2);
  headerRow.values = ['Register', 'Total', 'Open', 'Overdue', 'Due ≤ 30 days', 'Completed', 'No due date'];
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  sheet.columns = [{ width: 24 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 15 }, { width: 12 }, { width: 14 }];

  for (const { register, records } of groups) {
    const open = records.filter((r) => !CLOSED_STATUSES.has(r.status));
    sheet.addRow([
      register.name,
      records.length,
      open.length,
      open.filter((r) => dueState(r.dueDate, r.status) === 'overdue').length,
      open.filter((r) => dueState(r.dueDate, r.status) === 'due-soon').length,
      records.filter((r) => r.status === 'Completed').length,
      open.filter((r) => !r.dueDate).length,
    ]);
  }

  return sheet;
}

/**
 * Build a workbook. With one register it produces that sheet alone; with several it
 * produces the whole master file, Summary first — the same layout the team's
 * Engineering Master file already uses.
 */
export async function buildWorkbook(groups) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Engineering Activity Tracker';
  workbook.created = new Date();

  if (groups.length > 1) writeSummarySheet(workbook, groups);
  for (const { register, records } of groups) writeRegisterSheet(workbook, register, records);

  return workbook.xlsx.writeBuffer();
}
