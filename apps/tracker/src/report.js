/**
 * The printable status report.
 *
 * One page the department can attach to an email or take into a meeting: the
 * headline figures, each register's position, and everything that is late or
 * falls due inside the month. It is deliberately the same content as the
 * dashboard rather than a second report with its own numbers — it is built from
 * the same `summarise()` output, so the sheet somebody prints and the screen
 * somebody is looking at cannot disagree.
 *
 * The standard 14 PDF fonts are used, so no font binary ships with the app and
 * the file opens identically everywhere.
 */

import PdfPrinter from 'pdfmake';

import { CLOSED_STATUSES, DUE_SOON_DAYS } from './registers.js';

const FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

const INK = '#0b0b0b';
const MUTED = '#6b6a66';
const RULE = '#d8d7d0';
const ACCENT = '#1c5cab';
const CRITICAL = '#c0392b';
const WARNING = '#8a5a06';

const asDate = (iso) => (iso ? String(iso).slice(0, 10) : '—');

function formatToday() {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

/** The six headline figures, as a row of boxed cells. */
function figureRow(totals) {
  const cell = (label, value, colour = INK) => ({
    stack: [
      { text: label, fontSize: 8, color: MUTED, margin: [0, 0, 0, 3] },
      { text: String(value), fontSize: 18, bold: true, color: colour },
    ],
    margin: [8, 8, 8, 8],
  });

  return {
    table: {
      widths: ['*', '*', '*', '*', '*', '*'],
      body: [
        [
          cell('Total Jobs', totals.all),
          cell('Open', totals.open),
          cell('Closed', totals.closed),
          cell(`Due in ${DUE_SOON_DAYS} days`, totals.dueSoon),
          cell('Completed', totals.completed),
          cell('Overdue', totals.overdue, totals.overdue > 0 ? CRITICAL : INK),
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.7,
      vLineWidth: () => 0.7,
      hLineColor: () => RULE,
      vLineColor: () => RULE,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 0, 0, 18],
  };
}

const headerCell = (text, alignment = 'left') => ({
  text,
  bold: true,
  fontSize: 8.5,
  color: MUTED,
  alignment,
  margin: [0, 4, 0, 4],
});

/** Hairline rows, no vertical rules — a table to read, not a grid to decode. */
const TABLE_LAYOUT = {
  hLineWidth: (i) => (i === 1 ? 0.8 : 0.4),
  vLineWidth: () => 0,
  hLineColor: () => RULE,
  paddingLeft: () => 4,
  paddingRight: () => 4,
  paddingTop: () => 4,
  paddingBottom: () => 4,
};

function registerTable(byRegister) {
  const body = [
    [
      headerCell('Register'),
      headerCell('Total', 'right'),
      headerCell('Open', 'right'),
      headerCell('Overdue', 'right'),
      // Plain ASCII on purpose: the standard-14 fonts are WinAnsi, and "≤"
      // is not in that encoding — it printed as `"d` rather than as a symbol.
      headerCell(`Due in ${DUE_SOON_DAYS}d`, 'right'),
      headerCell('Closed', 'right'),
    ],
  ];

  for (const row of byRegister) {
    body.push([
      { text: row.name, fontSize: 9.5, bold: true },
      { text: String(row.total), fontSize: 9.5, alignment: 'right', color: MUTED },
      { text: String(row.open), fontSize: 9.5, alignment: 'right' },
      {
        text: String(row.overdue),
        fontSize: 9.5,
        alignment: 'right',
        color: row.overdue > 0 ? CRITICAL : MUTED,
        bold: row.overdue > 0,
      },
      {
        text: String(row.dueSoon),
        fontSize: 9.5,
        alignment: 'right',
        color: row.dueSoon > 0 ? WARNING : MUTED,
      },
      { text: String(row.closed), fontSize: 9.5, alignment: 'right', color: MUTED },
    ]);
  }

  return {
    table: { headerRows: 1, widths: ['*', 42, 42, 48, 52, 46], body },
    layout: TABLE_LAYOUT,
    margin: [0, 0, 0, 20],
  };
}

function attentionTable(attention, registerNames) {
  if (!attention.length) {
    return {
      text: `Nothing is overdue or due within ${DUE_SOON_DAYS} days.`,
      fontSize: 10,
      color: MUTED,
      italics: true,
      margin: [0, 4, 0, 0],
    };
  }

  const body = [
    [
      // Short enough for the codes it holds, wide enough that its own heading
      // does not wrap to two lines and push every row taller.
      headerCell('Register'),
      headerCell('Ref'),
      headerCell('Description'),
      headerCell('Due'),
      headerCell('Action by'),
      headerCell('Initiator'),
    ],
  ];

  for (const row of attention) {
    const late = row.days !== null && row.days < 0;
    body.push([
      { text: registerNames.get(row.register) ?? row.register, fontSize: 8.5, color: MUTED, noWrap: true },
      { text: row.ref ?? '—', fontSize: 8.5, bold: true },
      { text: row.title ?? '—', fontSize: 8.5 },
      {
        stack: [
          {
            text: late ? `${Math.abs(row.days)}d late` : `in ${row.days}d`,
            fontSize: 8.5,
            bold: true,
            color: late ? CRITICAL : WARNING,
          },
          { text: asDate(row.dueDate), fontSize: 7.5, color: MUTED },
        ],
      },
      { text: row.actionBy ?? 'Unassigned', fontSize: 8.5, color: row.actionBy ? INK : MUTED },
      { text: row.initiator ?? '—', fontSize: 8.5, color: MUTED },
    ]);
  }

  return {
    table: { headerRows: 1, widths: [52, 72, '*', 52, 68, 56], body },
    layout: TABLE_LAYOUT,
  };
}

/**
 * Build the report.
 *
 * `logo` is a data URI the department uploads in Settings, or null — in which
 * case the heading stands alone rather than a placeholder standing in for a
 * logo nobody supplied.
 */
export async function buildReport({
  summary,
  registerNames,
  logo,
  logoRight,
  generatedBy,
  scopeNote,
}) {
  const printer = new PdfPrinter(FONTS);

  // Centred only when it sits between two logos. With one logo, or none, a
  // centred heading drifts off-axis against the page rather than the pair.
  const centred = Boolean(logo && logoRight);

  const heading = {
    stack: [
      {
        text: 'Engineering Department Updates',
        fontSize: 17,
        bold: true,
        color: INK,
        alignment: centred ? 'center' : 'left',
      },
      {
        text: `Solid Handling Plant · DCU — status as at ${formatToday()}`,
        fontSize: 9.5,
        color: MUTED,
        alignment: centred ? 'center' : 'left',
        margin: [0, 3, 0, 0],
      },
    ],
  };

  const docDefinition = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [32, 32, 32, 44],
    defaultStyle: { font: 'Helvetica', color: INK },

    header: null,
    footer: (currentPage, pageCount) => ({
      columns: [
        {
          text: `Generated ${formatToday()}${generatedBy ? ` by ${generatedBy}` : ''}`,
          fontSize: 8,
          color: MUTED,
        },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          fontSize: 8,
          color: MUTED,
          alignment: 'right',
        },
      ],
      margin: [32, 12, 32, 0],
    }),

    content: [
      {
        // The contractor's mark at the left, the client's at the right, with
        // the heading between them — the arrangement the team's own workbooks
        // use. Each column is a fixed width so the middle one stays centred on
        // the page whatever shape the two images turn out to be.
        columns: [
          logo ? { image: logo, fit: [120, 38], width: 130 } : { text: '', width: logoRight ? 130 : 0 },
          { ...heading, width: '*', margin: [12, 0, 12, 0] },
          logoRight
            ? { image: logoRight, fit: [120, 38], width: 130, alignment: 'right' }
            : { text: '', width: logo ? 130 : 0 },
        ],
        columnGap: 0,
        margin: [0, 0, 0, 6],
      },
      {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 762, y2: 0, lineWidth: 1, lineColor: ACCENT }],
        margin: [0, 8, 0, 16],
      },

      scopeNote && { text: scopeNote, fontSize: 8.5, color: MUTED, margin: [0, 0, 0, 10] },

      figureRow(summary.totals),

      { text: 'Each register', fontSize: 11, bold: true, margin: [0, 0, 0, 6] },
      registerTable(summary.byRegister),

      {
        text: 'Needs attention',
        fontSize: 11,
        bold: true,
        margin: [0, 0, 0, 2],
      },
      {
        text: `Overdue, and due within ${DUE_SOON_DAYS} days — soonest first.`,
        fontSize: 8.5,
        color: MUTED,
        margin: [0, 0, 0, 6],
      },
      attentionTable(summary.attention, registerNames),
    ].filter(Boolean),
  };

  const pdf = printer.createPdfKitDocument(docDefinition);

  return new Promise((resolve, reject) => {
    const chunks = [];
    pdf.on('data', (chunk) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

export { CLOSED_STATUSES };
