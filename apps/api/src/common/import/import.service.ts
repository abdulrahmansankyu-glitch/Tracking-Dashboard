import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { z, type ZodTypeAny } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../context/request-context';

/**
 * Excel import.
 *
 * Two decisions that matter to whoever actually uses this:
 *
 *  1. Every row is validated before anything is written. A 500-row product sheet with
 *     three bad rows imports 497 and hands back a downloadable error sheet naming the
 *     row, column and reason — rather than failing wholesale or, worse, half-importing.
 *  2. Ids created by a run are recorded on the ImportJob, so a mistaken import is one
 *     click to undo instead of an evening of manual deletion.
 */

export interface ImportColumn {
  /** Header text expected in the sheet (matched case-insensitively, spaces ignored) */
  header: string;
  /** Field name on the created record */
  field: string;
  required?: boolean;
  /** Per-cell validation/coercion */
  schema?: ZodTypeAny;
  /** Resolve a human value to a foreign key, e.g. category name → categoryId */
  resolve?: (value: string, user: AuthenticatedUser) => Promise<string | null>;
}

export interface ImportRowError {
  row: number;
  column?: string;
  message: string;
}

export interface ImportResult {
  jobId: string;
  totalRows: number;
  successRows: number;
  failedRows: number;
  errors: ImportRowError[];
  createdIds: string[];
}

export interface ImportOptions {
  entityType: string;
  columns: ImportColumn[];
  /** Persists one validated row. Returns the created id. */
  persist: (data: Record<string, unknown>, user: AuthenticatedUser) => Promise<string>;
  /** Rows already present are updated rather than rejected as duplicates */
  upsertKey?: string;
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Blank template with the correct headers, so users start from a valid sheet. */
  async buildTemplate(columns: ImportColumn[], entityType: string): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(entityType.slice(0, 31));

    sheet.columns = columns.map((column) => ({
      header: column.required ? `${column.header} *` : column.header,
      key: column.field,
      width: Math.max(16, column.header.length + 6),
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
    headerRow.height = 22;

    // Second row explains the rules — most import failures are a user guessing a format.
    const noteRow = sheet.getRow(2);
    columns.forEach((column, index) => {
      const cell = noteRow.getCell(index + 1);
      cell.value = column.required ? 'Required' : 'Optional';
      cell.font = { size: 8, italic: true, color: { argb: 'FF94A3B8' } };
    });

    sheet.views = [{ state: 'frozen', ySplit: 2 }];
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async importFromBuffer(
    buffer: Buffer,
    fileName: string,
    options: ImportOptions,
    user: AuthenticatedUser,
  ): Promise<ImportResult> {
    const job = await this.prisma.importJob.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        entityType: options.entityType,
        fileName,
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    const errors: ImportRowError[] = [];
    const createdIds: string[] = [];
    let totalRows = 0;

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new BadRequestException('The uploaded file has no sheets');

      // --- Map headers to columns ---
      const headerRow = sheet.getRow(1);
      const columnIndex = new Map<string, number>();
      headerRow.eachCell((cell, index) => {
        const normalised = this.normalise(String(cell.value ?? ''));
        if (normalised) columnIndex.set(normalised, index);
      });

      const missing = options.columns
        .filter((c) => c.required && !columnIndex.has(this.normalise(c.header)))
        .map((c) => c.header);
      if (missing.length > 0) {
        throw new BadRequestException(
          `The sheet is missing required columns: ${missing.join(', ')}`,
        );
      }

      // --- Process rows ---
      const lastRow = sheet.rowCount;
      for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (this.isEmptyRow(row, columnIndex)) continue;
        // Skip the "Required/Optional" hint row from our own template.
        if (rowNumber === 2 && this.looksLikeHintRow(row, columnIndex)) continue;

        totalRows += 1;
        const parsed = await this.parseRow(row, rowNumber, options.columns, columnIndex, user, errors);
        if (!parsed) continue;

        try {
          const id = await options.persist(parsed, user);
          createdIds.push(id);
        } catch (error) {
          errors.push({
            row: rowNumber,
            message: this.friendlyError(error),
          });
        }
      }

      const successRows = createdIds.length;
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: errors.length === 0 ? 'COMPLETED' : successRows > 0 ? 'PARTIAL' : 'FAILED',
          totalRows,
          processedRows: totalRows,
          successRows,
          failedRows: errors.length,
          errors: errors.length ? (errors as unknown as object) : undefined,
          createdIds,
          completedAt: new Date(),
        },
      });

      return { jobId: job.id, totalRows, successRows, failedRows: errors.length, errors, createdIds };
    } catch (error) {
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          errors: [{ row: 0, message: (error as Error).message }] as unknown as object,
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  /** Error report as a sheet the user can fix and re-upload. */
  async buildErrorReport(errors: ImportRowError[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Import Errors');
    sheet.columns = [
      { header: 'Row', key: 'row', width: 10 },
      { header: 'Column', key: 'column', width: 24 },
      { header: 'Problem', key: 'message', width: 80 },
    ];
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };
    errors.forEach((error) => sheet.addRow(error));
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private async parseRow(
    row: ExcelJS.Row,
    rowNumber: number,
    columns: ImportColumn[],
    columnIndex: Map<string, number>,
    user: AuthenticatedUser,
    errors: ImportRowError[],
  ): Promise<Record<string, unknown> | null> {
    const data: Record<string, unknown> = {};
    let rowFailed = false;

    for (const column of columns) {
      const index = columnIndex.get(this.normalise(column.header));
      if (index === undefined) continue;

      const raw = this.cellText(row.getCell(index));

      if (!raw) {
        if (column.required) {
          errors.push({ row: rowNumber, column: column.header, message: 'This field is required' });
          rowFailed = true;
        }
        continue;
      }

      // Foreign keys are given by name in the sheet ("Banarasi Saree"), not by id.
      if (column.resolve) {
        try {
          const resolved = await column.resolve(raw, user);
          if (!resolved) {
            errors.push({
              row: rowNumber,
              column: column.header,
              message: `"${raw}" was not found. Create it first, or correct the spelling.`,
            });
            rowFailed = true;
            continue;
          }
          data[column.field] = resolved;
        } catch (error) {
          errors.push({ row: rowNumber, column: column.header, message: this.friendlyError(error) });
          rowFailed = true;
        }
        continue;
      }

      if (column.schema) {
        const result = column.schema.safeParse(raw);
        if (!result.success) {
          errors.push({
            row: rowNumber,
            column: column.header,
            message: result.error.errors.map((e) => e.message).join('; '),
          });
          rowFailed = true;
          continue;
        }
        data[column.field] = result.data;
      } else {
        data[column.field] = raw;
      }
    }

    return rowFailed ? null : data;
  }

  /** Excel cells may hold formulas, rich text or hyperlinks; reduce all to plain text. */
  private cellText(cell: ExcelJS.Cell): string {
    const value = cell.value;
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const candidate = value as unknown as Record<string, unknown>;
      if ('richText' in candidate) {
        const parts = candidate.richText as Array<{ text: string }>;
        return parts.map((p) => p.text).join('').trim();
      }
      // Formula cells expose the computed value as `result`; hyperlinks expose `text`.
      if ('result' in candidate) return String(candidate.result ?? '').trim();
      if ('text' in candidate) return String(candidate.text ?? '').trim();
      if ('error' in candidate) return '';
    }
    return String(value).trim();
  }

  private isEmptyRow(row: ExcelJS.Row, columnIndex: Map<string, number>): boolean {
    for (const index of columnIndex.values()) {
      if (this.cellText(row.getCell(index))) return false;
    }
    return true;
  }

  private looksLikeHintRow(row: ExcelJS.Row, columnIndex: Map<string, number>): boolean {
    const values = [...columnIndex.values()].map((i) => this.cellText(row.getCell(i)).toLowerCase());
    return values.every((v) => v === '' || v === 'required' || v === 'optional');
  }

  /** "product_sku *" and "Product SKU" must map to the same column. */
  private normalise(header: string): string {
    return header.replace(/\*/g, '').replace(/[\s_-]/g, '').trim().toLowerCase();
  }

  private friendlyError(error: unknown): string {
    const message = (error as Error).message ?? 'Unknown error';
    if (message.includes('Unique constraint')) {
      return 'A record with this value already exists';
    }
    if (message.includes('Foreign key constraint')) {
      return 'A referenced record does not exist';
    }
    return message.split('\n')[0] ?? message;
  }
}

/** Cell coercions shared by the import descriptors. */
export const importCoercions = {
  decimal: z
    .string()
    .transform((value) => value.replace(/[₹,\s]/g, ''))
    .pipe(z.coerce.number().finite()),
  positiveDecimal: z
    .string()
    .transform((value) => value.replace(/[₹,\s]/g, ''))
    .pipe(z.coerce.number().finite().min(0, 'Cannot be negative')),
  integer: z.coerce.number().int(),
  boolean: z
    .string()
    .transform((value) => ['yes', 'true', '1', 'y'].includes(value.toLowerCase())),
  date: z.coerce.date(),
  text: z.string().trim(),
};
