import {
  Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Res, Type,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Permission } from '@intoto/shared';
import type { ZodTypeAny } from 'zod';

import { Audit, CurrentUser, RequirePermissions, SkipAudit } from '../decorators';
import { ArchiveDto, ExportQueryDto, QueryDto } from '../dto/query.dto';
import { ExportService, type ExportColumn } from '../export/export.service';
import { ImportService, type ImportColumn } from '../import/import.service';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import type { AuthenticatedUser } from '../context/request-context';
import type { BaseCrudService } from './base-crud.service';

/**
 * Builds a REST controller giving a resource the full operation set the spec requires on
 * every page: list with search/filter/sort/paginate, read, create, update, delete,
 * archive, restore, Excel/CSV/PDF export, Excel import with a downloadable template,
 * and audit history.
 *
 * Written once, applied to every master. Adding a new resource is a descriptor plus a
 * service — not another 300 lines of near-identical endpoints that drift apart over time.
 */

export interface CrudControllerOptions<TService = unknown> {
  /**
   * The concrete service class, used as the DI token.
   *
   * Required because a generic type parameter erases to `Object` in the emitted
   * `design:paramtypes` metadata, leaving Nest unable to resolve the dependency. The
   * explicit token sidesteps type erasure entirely.
   */
  serviceClass: Type<TService>;
  /** URL segment, e.g. 'suppliers' */
  path: string;
  /** Swagger tag */
  tag: string;
  /** RBAC resource prefix, e.g. 'supplier' → supplier:read, supplier:create … */
  resource: string;
  /** Audit entity name, e.g. 'Supplier' */
  entityType: string;
  /** Field used as the record's human label in audit rows */
  labelField: string;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  exportColumns: ExportColumn[];
  importColumns?: ImportColumn[];
  /** Turns a validated import row into a persisted record; returns the new id */
  importPersist?: (data: Record<string, unknown>, user: AuthenticatedUser) => Promise<string>;
}

/**
 * Resource-specific routes live in their own controller sharing the same `@Controller`
 * path, rather than in a subclass of this one. Subclassing a factory-produced Nest
 * controller means relying on decorator metadata surviving inheritance, which is
 * fragile; two flat controllers on the same path is plainly correct.
 */
export function createCrudController<TService extends BaseCrudService<Record<string, unknown>>>(
  options: CrudControllerOptions<TService>,
): Type<unknown> {
  const permission = (action: string) => `${options.resource}:${action}` as Permission;

  // NOTE: create/update/delete/archive/restore carry no @Audit decorator. Each is
  // logged by BaseCrudService, which has the previous row in hand and can record a
  // field-level diff plus a before-snapshot. Adding @Audit here too would write a
  // second, poorer entry for every mutation and double the size of the audit table.
  @ApiTags(options.tag)
  @ApiBearerAuth()
  @Controller(options.path)
  class CrudController {
    constructor(
      @Inject(options.serviceClass) readonly service: TService,
      @Inject(ExportService) readonly exportService: ExportService,
      @Inject(ImportService) readonly importService: ImportService,
    ) {}

    @Get()
    @RequirePermissions(permission('read'))
    @SkipAudit()
    @ApiOperation({ summary: `List ${options.tag.toLowerCase()}` })
    findAll(@Query() query: QueryDto, @CurrentUser() user: AuthenticatedUser) {
      return this.service.findAll(user, query);
    }

    /**
     * Declared before `:id` — Nest matches routes in declaration order, so a literal
     * segment registered after a parameter route would never be reached.
     */
    @Get('export')
    @RequirePermissions(permission('export'))
    @Audit({ entityType: options.entityType, action: 'EXPORT' })
    @ApiOperation({ summary: 'Export to Excel, CSV or PDF' })
    async export(
      @Query() query: ExportQueryDto,
      @CurrentUser() user: AuthenticatedUser,
      @Res() response: Response,
    ): Promise<void> {
      const rows = await this.service.findAllForExport(user, query);
      const columns = query.columns?.length
        ? options.exportColumns.filter((column) => query.columns!.includes(column.key))
        : options.exportColumns;

      const meta = {
        title: query.title ?? options.tag,
        organizationName: 'Intoto',
        generatedBy: user.name,
        filtersApplied: describeFilters(query),
        totalColumns: columns.filter((c) => c.format === 'currency').map((c) => c.key),
      };

      const stamp = new Date().toISOString().slice(0, 10);
      const base = `${options.path}-${stamp}`;

      switch (query.format) {
        case 'csv': {
          const buffer = this.exportService.toCsv(rows, columns);
          send(response, buffer, `${base}.csv`, 'text/csv; charset=utf-8');
          return;
        }
        case 'pdf': {
          const buffer = await this.exportService.toPdf(rows, columns, meta);
          send(response, buffer, `${base}.pdf`, 'application/pdf');
          return;
        }
        case 'json': {
          response.json(rows);
          return;
        }
        default: {
          const buffer = await this.exportService.toExcel(rows, columns, meta);
          send(
            response,
            buffer,
            `${base}.xlsx`,
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          );
        }
      }
    }

    @Get('import/template')
    @RequirePermissions(permission('import'))
    @SkipAudit()
    @ApiOperation({ summary: 'Download a blank import template with the correct headers' })
    async importTemplate(@Res() response: Response): Promise<void> {
      if (!options.importColumns) {
        response.status(404).json({ message: 'Import is not available for this resource' });
        return;
      }
      const buffer = await this.importService.buildTemplate(
        options.importColumns,
        options.entityType,
      );
      send(
        response,
        buffer,
        `${options.path}-import-template.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    }

    @Post('import')
    @RequirePermissions(permission('import'))
    @Audit({ entityType: options.entityType, action: 'IMPORT' })
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({ summary: 'Import from an Excel file; returns a per-row error report' })
    async import(
      @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
      @CurrentUser() user: AuthenticatedUser,
    ) {
      if (!options.importColumns || !options.importPersist) {
        return { message: 'Import is not available for this resource' };
      }
      if (!file) {
        return { message: 'Attach an .xlsx file to import' };
      }
      return this.importService.importFromBuffer(
        file.buffer,
        file.originalname,
        {
          entityType: options.entityType,
          columns: options.importColumns,
          persist: options.importPersist,
        },
        user,
      );
    }

    @Get(':id')
    @RequirePermissions(permission('read'))
    @SkipAudit()
    @ApiOperation({ summary: 'Get one record' })
    findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
      return this.service.findOne(user, id);
    }

    @Get(':id/history')
    @RequirePermissions(permission('read'))
    @SkipAudit()
    @ApiOperation({ summary: 'Full change history for this record' })
    history(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
      return this.service.history(user, id);
    }

    @Post()
    @RequirePermissions(permission('create'))
    @ApiOperation({ summary: 'Create a record' })
    create(
      @Body(new ZodValidationPipe(options.createSchema)) body: Record<string, unknown>,
      @CurrentUser() user: AuthenticatedUser,
    ) {
      return this.service.create(user, body);
    }

    @Patch(':id')
    @RequirePermissions(permission('update'))
    @ApiOperation({ summary: 'Update a record' })
    update(
      @Param('id') id: string,
      @Body(new ZodValidationPipe(options.updateSchema)) body: Record<string, unknown>,
      @CurrentUser() user: AuthenticatedUser,
    ) {
      return this.service.update(user, id, body);
    }

    @Delete(':id')
    @RequirePermissions(permission('delete'))
    @ApiOperation({ summary: 'Soft delete — recoverable, and blocked if still referenced' })
    remove(
      @Param('id') id: string,
      @Query() query: ArchiveDto,
      @CurrentUser() user: AuthenticatedUser,
    ) {
      return this.service.remove(user, id, query.reason);
    }

    @Post(':id/archive')
    @RequirePermissions(permission('archive'))
    @ApiOperation({ summary: 'Archive — hidden from new transactions, history preserved' })
    archive(
      @Param('id') id: string,
      @Body() body: ArchiveDto,
      @CurrentUser() user: AuthenticatedUser,
    ) {
      return this.service.archive(user, id, body.reason);
    }

    @Post(':id/restore')
    @RequirePermissions(permission('restore'))
    @ApiOperation({ summary: 'Restore an archived or deleted record' })
    restore(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
      return this.service.restore(user, id);
    }
  }

  return CrudController;
}

function send(response: Response, buffer: Buffer, filename: string, contentType: string): void {
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  response.setHeader('Content-Length', buffer.length);
  response.end(buffer);
}

/** Human-readable filter summary printed on the export, so a saved file is self-describing. */
function describeFilters(query: ExportQueryDto): string | undefined {
  const parts: string[] = [];
  if (query.search) parts.push(`search "${query.search}"`);
  if (query.dateFrom || query.dateTo) {
    parts.push(`dates ${query.dateFrom?.slice(0, 10) ?? '…'} to ${query.dateTo?.slice(0, 10) ?? '…'}`);
  }
  if (query.onlyArchived) parts.push('archived only');
  else if (query.includeArchived) parts.push('including archived');
  for (const filter of query.filters ?? []) {
    parts.push(`${filter.field} ${filter.operator} ${String(filter.value ?? '')}`);
  }
  return parts.length ? parts.join(', ') : undefined;
}
