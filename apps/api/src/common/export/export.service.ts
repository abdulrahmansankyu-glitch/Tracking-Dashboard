import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * Excel, CSV and PDF generation.
 *
 * One service for the whole application so every export looks the same: identical
 * header styling, identical Indian number formatting, identical footer showing who
 * generated it and when. An export that lands on a chartered accountant's desk should
 * be self-describing.
 */

export interface ExportColumn {
  key: string;
  header: string;
  width?: number;
  /** `currency` renders ₹ with Indian grouping; `number` respects `decimals` */
  format?: 'text' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'boolean';
  decimals?: number;
  /** Read a nested value, e.g. (row) => row.supplier?.companyName */
  accessor?: (row: Record<string, unknown>) => unknown;
}

export interface ExportMeta {
  title: string;
  subtitle?: string;
  organizationName?: string;
  generatedBy?: string;
  filtersApplied?: string;
  /** Columns to total in the footer row */
  totalColumns?: string[];
}

// pdfmake needs a font descriptor. The standard 14 PDF fonts are built into every
// viewer, so using Helvetica keeps the bundle free of embedded font binaries.
const PDF_FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly printer = new PdfPrinter(PDF_FONTS);

  // -------------------------------------------------------------------------
  // Excel
  // -------------------------------------------------------------------------

  async toExcel(
    rows: Record<string, unknown>[],
    columns: ExportColumn[],
    meta: ExportMeta,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = meta.organizationName ?? 'Intoto ERP';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(this.safeSheetName(meta.title), {
      views: [{ state: 'frozen', ySplit: meta.subtitle ? 4 : 3 }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });

    // --- Title block ---
    const lastColumn = String.fromCharCode(64 + Math.min(columns.length, 26));
    sheet.mergeCells(`A1:${lastColumn}1`);
    const titleCell = sheet.getCell('A1');
    titleCell.value = meta.title;
    titleCell.font = { size: 16, bold: true, color: { argb: 'FF1E293B' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
    sheet.getRow(1).height = 26;

    sheet.mergeCells(`A2:${lastColumn}2`);
    const subtitleCell = sheet.getCell('A2');
    subtitleCell.value = [
      meta.organizationName,
      meta.subtitle,
      `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      meta.generatedBy ? `by ${meta.generatedBy}` : undefined,
    ]
      .filter(Boolean)
      .join('  ·  ');
    subtitleCell.font = { size: 9, color: { argb: 'FF64748B' } };

    let headerRowIndex = 3;
    if (meta.filtersApplied) {
      sheet.mergeCells(`A3:${lastColumn}3`);
      const filterCell = sheet.getCell('A3');
      filterCell.value = `Filters: ${meta.filtersApplied}`;
      filterCell.font = { size: 9, italic: true, color: { argb: 'FF94A3B8' } };
      headerRowIndex = 4;
    }

    // --- Header row ---
    const headerRow = sheet.getRow(headerRowIndex);
    columns.forEach((column, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = column.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF4F46E5' } } };
      sheet.getColumn(index + 1).width = column.width ?? this.defaultWidth(column);
    });
    headerRow.height = 22;

    // --- Data rows ---
    rows.forEach((row, rowIndex) => {
      const sheetRow = sheet.getRow(headerRowIndex + 1 + rowIndex);
      columns.forEach((column, columnIndex) => {
        const cell = sheetRow.getCell(columnIndex + 1);
        const value = this.readValue(row, column);
        cell.value = this.toExcelValue(value, column);
        cell.numFmt = this.numberFormat(column);
        cell.alignment = {
          horizontal: this.isNumeric(column) ? 'right' : 'left',
          vertical: 'middle',
        };
        cell.font = { size: 10 };
        if (rowIndex % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        }
      });
    });

    // --- Totals ---
    if (meta.totalColumns?.length && rows.length > 0) {
      const totalRow = sheet.getRow(headerRowIndex + rows.length + 1);
      columns.forEach((column, index) => {
        const cell = totalRow.getCell(index + 1);
        if (index === 0) {
          cell.value = 'TOTAL';
        } else if (meta.totalColumns?.includes(column.key)) {
          const sum = rows.reduce((acc, row) => acc + this.toNumber(this.readValue(row, column)), 0);
          cell.value = sum;
          cell.numFmt = this.numberFormat(column);
        }
        cell.font = { bold: true, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
        cell.border = { top: { style: 'double', color: { argb: 'FF6366F1' } } };
        cell.alignment = { horizontal: this.isNumeric(column) ? 'right' : 'left' };
      });
    }

    sheet.autoFilter = {
      from: { row: headerRowIndex, column: 1 },
      to: { row: headerRowIndex + rows.length, column: columns.length },
    };

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // -------------------------------------------------------------------------
  // CSV
  // -------------------------------------------------------------------------

  toCsv(rows: Record<string, unknown>[], columns: ExportColumn[]): Buffer {
    const escape = (value: unknown): string => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [columns.map((c) => escape(c.header)).join(',')];
    for (const row of rows) {
      lines.push(
        columns
          .map((column) => escape(this.formatForText(this.readValue(row, column), column)))
          .join(','),
      );
    }
    // BOM so Excel opens UTF-8 (₹, Devanagari product names) correctly on Windows.
    return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
  }

  // -------------------------------------------------------------------------
  // PDF
  // -------------------------------------------------------------------------

  async toPdf(
    rows: Record<string, unknown>[],
    columns: ExportColumn[],
    meta: ExportMeta,
  ): Promise<Buffer> {
    const body: unknown[][] = [
      columns.map((column) => ({
        text: column.header,
        style: 'tableHeader',
        alignment: this.isNumeric(column) ? 'right' : 'left',
      })),
    ];

    for (const row of rows) {
      body.push(
        columns.map((column) => ({
          text: this.formatForText(this.readValue(row, column), column),
          alignment: this.isNumeric(column) ? 'right' : 'left',
          fontSize: 8,
        })),
      );
    }

    if (meta.totalColumns?.length && rows.length > 0) {
      body.push(
        columns.map((column, index) => {
          if (index === 0) return { text: 'TOTAL', bold: true, fontSize: 8 };
          if (!meta.totalColumns?.includes(column.key)) return { text: '', fontSize: 8 };
          const sum = rows.reduce((acc, row) => acc + this.toNumber(this.readValue(row, column)), 0);
          return {
            text: this.formatForText(sum, column),
            bold: true,
            alignment: 'right',
            fontSize: 8,
          };
        }),
      );
    }

    const definition: TDocumentDefinitions = {
      pageSize: 'A4',
      pageOrientation: columns.length > 6 ? 'landscape' : 'portrait',
      pageMargins: [28, 60, 28, 44],
      defaultStyle: { font: 'Helvetica', fontSize: 9 },
      header: {
        margin: [28, 20, 28, 0],
        columns: [
          {
            stack: [
              { text: meta.title, style: 'docTitle' },
              {
                text: [meta.organizationName, meta.subtitle].filter(Boolean).join('  ·  '),
                style: 'docSubtitle',
              },
            ],
          },
          {
            text: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            alignment: 'right',
            style: 'docSubtitle',
          },
        ],
      },
      footer: (currentPage: number, pageCount: number) => ({
        margin: [28, 10, 28, 0],
        columns: [
          {
            text: meta.generatedBy ? `Generated by ${meta.generatedBy}` : 'Intoto ERP',
            style: 'footer',
          },
          { text: `Page ${currentPage} of ${pageCount}`, alignment: 'right', style: 'footer' },
        ],
      }),
      content: [
        ...(meta.filtersApplied
          ? [{ text: `Filters: ${meta.filtersApplied}`, style: 'filters', margin: [0, 0, 0, 8] as [number, number, number, number] }]
          : []),
        {
          table: {
            headerRows: 1,
            widths: columns.map((c) => (c.width ? c.width : '*')),
            body: body as never,
          },
          layout: {
            fillColor: (rowIndex: number) =>
              rowIndex === 0 ? '#6366F1' : rowIndex % 2 === 0 ? '#F8FAFC' : null,
            hLineWidth: () => 0.5,
            vLineWidth: () => 0,
            hLineColor: () => '#E2E8F0',
            paddingTop: () => 5,
            paddingBottom: () => 5,
          },
        },
        ...(rows.length === 0
          ? [{ text: 'No records matched the selected filters.', style: 'empty', margin: [0, 20, 0, 0] as [number, number, number, number] }]
          : []),
      ],
      styles: {
        docTitle: { fontSize: 14, bold: true, color: '#1E293B' },
        docSubtitle: { fontSize: 8, color: '#64748B' },
        tableHeader: { bold: true, fontSize: 8, color: '#FFFFFF' },
        filters: { fontSize: 8, italics: true, color: '#94A3B8' },
        footer: { fontSize: 7, color: '#94A3B8' },
        empty: { fontSize: 10, italics: true, color: '#94A3B8', alignment: 'center' },
      },
    };

    return this.renderPdf(definition);
  }

  /** Render any pdfmake definition — used by the invoice and report templates too. */
  renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = this.printer.createPdfKitDocument(definition);
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
      } catch (error) {
        this.logger.error(`PDF generation failed: ${(error as Error).message}`);
        reject(error as Error);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Value handling
  // -------------------------------------------------------------------------

  private readValue(row: Record<string, unknown>, column: ExportColumn): unknown {
    if (column.accessor) return column.accessor(row);
    // Support dotted paths so a descriptor can pull "supplier.companyName" directly.
    return column.key.split('.').reduce<unknown>((acc, segment) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[segment];
      return undefined;
    }, row);
  }

  /** Prisma returns Decimal objects; Excel needs real numbers to compute in-sheet. */
  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (value instanceof Prisma.Decimal) return value.toNumber();
    if (typeof value === 'number') return value;
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private toExcelValue(value: unknown, column: ExportColumn): ExcelJS.CellValue {
    if (value === null || value === undefined) return null;
    if (this.isNumeric(column)) return this.toNumber(value);
    if (column.format === 'date' || column.format === 'datetime') {
      return value instanceof Date ? value : new Date(String(value));
    }
    if (column.format === 'boolean') return value ? 'Yes' : 'No';
    if (value instanceof Prisma.Decimal) return value.toNumber();
    if (typeof value === 'object') return JSON.stringify(value);
    return value as ExcelJS.CellValue;
  }

  private formatForText(value: unknown, column: ExportColumn): string {
    if (value === null || value === undefined) return '';
    switch (column.format) {
      case 'currency':
        return this.toNumber(value).toLocaleString('en-IN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      case 'number':
        return this.toNumber(value).toLocaleString('en-IN', {
          minimumFractionDigits: column.decimals ?? 0,
          maximumFractionDigits: column.decimals ?? 2,
        });
      case 'percent':
        return `${this.toNumber(value).toFixed(column.decimals ?? 2)}%`;
      case 'date':
        return new Date(String(value)).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
      case 'datetime':
        return new Date(String(value)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      case 'boolean':
        return value ? 'Yes' : 'No';
      default:
        if (value instanceof Prisma.Decimal) return value.toString();
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }
  }

  private isNumeric(column: ExportColumn): boolean {
    return column.format === 'number' || column.format === 'currency' || column.format === 'percent';
  }

  private numberFormat(column: ExportColumn): string {
    switch (column.format) {
      case 'currency':
        // Indian digit grouping (##,##,##0) is not a built-in Excel format.
        return '[$₹-en-IN]##,##,##0.00';
      case 'number':
        return column.decimals ? `##,##,##0.${'0'.repeat(column.decimals)}` : '##,##,##0';
      case 'percent':
        return '0.00"%"';
      case 'date':
        return 'dd-mm-yyyy';
      case 'datetime':
        return 'dd-mm-yyyy hh:mm';
      default:
        return '@';
    }
  }

  private defaultWidth(column: ExportColumn): number {
    if (column.format === 'currency' || column.format === 'number') return 16;
    if (column.format === 'date') return 13;
    if (column.format === 'datetime') return 19;
    return Math.min(40, Math.max(12, column.header.length + 4));
  }

  /** Excel rejects sheet names containing : \ / ? * [ ] or longer than 31 characters. */
  private safeSheetName(name: string): string {
    return name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31) || 'Report';
  }
}
