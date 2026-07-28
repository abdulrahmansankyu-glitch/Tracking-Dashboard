import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import type { AuditFieldChange, Paginated, QueryParams } from '@intoto/shared';

import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../context/request-context';
import { buildQuery, pageMeta, type QueryBuilderOptions } from './query-builder';

/**
 * The behaviour every resource in the system shares: list with search/filter/sort/page,
 * read one, create, update, soft delete, archive, restore — each of them tenant-scoped
 * and each writing a field-level audit entry.
 *
 * Written once here rather than repeated across sixty modules. A domain service extends
 * this and adds only what is genuinely specific to it: GST computation for sales, cost
 * layers for inventory, double-entry posting for accounting.
 */

export interface CrudResourceConfig {
  /** Prisma model delegate name, e.g. "supplier" */
  model: Prisma.ModelName | string;
  /** Recorded in the audit trail */
  entityType: string;
  /** Field used as the human-readable label in audit rows and exports */
  labelField: string;
  query: QueryBuilderOptions;
  /** Relations eagerly loaded on `findOne` */
  detailInclude?: Record<string, unknown>;
  /** Relations eagerly loaded on `findMany` — keep this lean, it runs per row */
  listInclude?: Record<string, unknown>;
  /** Never returned to the client (hashes, secrets, encrypted blobs) */
  hiddenFields?: string[];
  /** Blocks deletion when any of these relations still has rows */
  protectedRelations?: string[];
}

type Delegate = {
  findMany: (args: unknown) => Promise<Record<string, unknown>[]>;
  findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
  count: (args: unknown) => Promise<number>;
  create: (args: unknown) => Promise<Record<string, unknown>>;
  update: (args: unknown) => Promise<Record<string, unknown>>;
};

export abstract class BaseCrudService<TRecord extends Record<string, unknown>> {
  protected abstract readonly config: CrudResourceConfig;

  constructor(protected readonly prisma: PrismaService) {}

  protected get delegate(): Delegate {
    const delegate = (this.prisma as unknown as Record<string, Delegate>)[
      this.lowerFirst(this.config.model)
    ];
    if (!delegate) {
      throw new Error(`Unknown Prisma model "${this.config.model}"`);
    }
    return delegate;
  }

  /**
   * Tenant + shop scope applied to every read and write.
   * Overridden by services whose model has no `shopId` (suppliers, products) or whose
   * scoping is indirect (sales lines scope through their invoice).
   */
  protected scopeWhere(user: AuthenticatedUser, requestedShopId?: string): Record<string, unknown> {
    return { organizationId: user.organizationId, ...(requestedShopId ? { shopId: requestedShopId } : {}) };
  }

  async findAll(user: AuthenticatedUser, params: QueryParams): Promise<Paginated<TRecord>> {
    const built = buildQuery(params, this.config.query, this.scopeWhere(user, params.shopId));

    const [rows, total] = await Promise.all([
      this.delegate.findMany({
        where: built.where,
        orderBy: built.orderBy,
        skip: built.skip,
        take: built.take,
        ...(this.config.listInclude ? { include: this.config.listInclude } : {}),
      }),
      this.delegate.count({ where: built.where }),
    ]);

    return {
      data: rows.map((row) => this.strip(row)) as TRecord[],
      meta: pageMeta(total, built.page, built.pageSize),
    };
  }

  /** Every row matching the query, unpaginated — used by Excel/PDF export. */
  async findAllForExport(user: AuthenticatedUser, params: QueryParams): Promise<TRecord[]> {
    const built = buildQuery(
      { ...params, page: 1, pageSize: 1 },
      this.config.query,
      this.scopeWhere(user, params.shopId),
    );
    const rows = await this.delegate.findMany({
      where: built.where,
      orderBy: built.orderBy,
      // Hard ceiling: an unbounded export on a million-row table would exhaust memory
      // and take the API down for everyone. Larger extracts go through a queued job.
      take: 50_000,
      ...(this.config.listInclude ? { include: this.config.listInclude } : {}),
    });
    return rows.map((row) => this.strip(row)) as TRecord[];
  }

  async findOne(user: AuthenticatedUser, id: string): Promise<TRecord> {
    const record = await this.delegate.findFirst({
      where: { id, ...this.scopeWhere(user) },
      ...(this.config.detailInclude ? { include: this.config.detailInclude } : {}),
    });
    if (!record) {
      throw new NotFoundException(`${this.config.entityType} not found`);
    }
    return this.strip(record) as TRecord;
  }

  async create(user: AuthenticatedUser, data: Record<string, unknown>): Promise<TRecord> {
    const record = await this.delegate.create({
      data: {
        ...data,
        organizationId: user.organizationId,
        ...(this.hasField('createdById') ? { createdById: user.id } : {}),
      },
    });
    await this.writeAudit(user, AuditAction.CREATE, record, undefined);
    return this.strip(record) as TRecord;
  }

  async update(
    user: AuthenticatedUser,
    id: string,
    data: Record<string, unknown>,
  ): Promise<TRecord> {
    const before = await this.requireRecord(user, id);
    const record = await this.delegate.update({
      where: { id },
      data,
    });
    await this.writeAudit(user, AuditAction.UPDATE, record, before);
    return this.strip(record) as TRecord;
  }

  /**
   * Soft delete. The row stays in the database so historical documents that reference
   * it still render, and an admin can restore it.
   */
  async remove(user: AuthenticatedUser, id: string, reason?: string): Promise<{ id: string }> {
    const before = await this.requireRecord(user, id);
    await this.assertNotInUse(id);

    await this.delegate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.writeAudit(user, AuditAction.DELETE, { id }, before, reason);
    return { id };
  }

  /** Retire a record from day-to-day use while keeping it fully intact and reportable. */
  async archive(user: AuthenticatedUser, id: string, reason?: string): Promise<TRecord> {
    const before = await this.requireRecord(user, id);
    const record = await this.delegate.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    await this.writeAudit(user, AuditAction.ARCHIVE, record, before, reason);
    return this.strip(record) as TRecord;
  }

  async restore(user: AuthenticatedUser, id: string): Promise<TRecord> {
    const before = await this.delegate.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!before) throw new NotFoundException(`${this.config.entityType} not found`);

    const record = await this.delegate.update({
      where: { id },
      data: { archivedAt: null, deletedAt: null },
    });
    await this.writeAudit(user, AuditAction.RESTORE, record, before);
    return this.strip(record) as TRecord;
  }

  /** Full change history for one record — the "Audit History" tab on every page. */
  async history(user: AuthenticatedUser, id: string) {
    return this.prisma.auditLog.findMany({
      where: {
        organizationId: user.organizationId,
        entityType: this.config.entityType,
        entityId: id,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        action: true,
        userName: true,
        changes: true,
        reason: true,
        ipAddress: true,
        createdAt: true,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  protected async requireRecord(
    user: AuthenticatedUser,
    id: string,
  ): Promise<Record<string, unknown>> {
    const record = await this.delegate.findFirst({ where: { id, ...this.scopeWhere(user) } });
    if (!record) throw new NotFoundException(`${this.config.entityType} not found`);
    return record;
  }

  /**
   * Refuse to delete a master record that live documents still point at. Deleting a
   * supplier with open bills would leave the payables ledger referencing nothing.
   */
  protected async assertNotInUse(id: string): Promise<void> {
    const relations = this.config.protectedRelations;
    if (!relations?.length) return;

    const record = await this.delegate.findFirst({
      where: { id },
      include: Object.fromEntries(relations.map((r) => [r, { take: 1, select: { id: true } }])),
    });
    if (!record) return;

    const blocking = relations.filter((relation) => {
      const value = record[relation];
      return Array.isArray(value) && value.length > 0;
    });
    if (blocking.length > 0) {
      throw new ForbiddenException(
        `This ${this.config.entityType.toLowerCase()} is used by existing ${blocking.join(
          ', ',
        )} and cannot be deleted. Archive it instead — it will be hidden from new transactions but history stays intact.`,
      );
    }
  }

  /** Compute the field-level diff and persist it. */
  protected async writeAudit(
    user: AuthenticatedUser,
    action: AuditAction,
    after: Record<string, unknown>,
    before?: Record<string, unknown>,
    reason?: string,
  ): Promise<void> {
    const changes = before ? this.diff(before, after) : undefined;
    // An update that changed nothing is noise in the history tab.
    if (action === AuditAction.UPDATE && changes && changes.length === 0) return;

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        userName: user.name,
        action,
        entityType: this.config.entityType,
        entityId: (after.id as string | undefined) ?? (before?.id as string | undefined) ?? null,
        entityLabel:
          (after[this.config.labelField] as string | undefined) ??
          (before?.[this.config.labelField] as string | undefined) ??
          null,
        shopId: (after.shopId as string | undefined) ?? null,
        changes: changes ? (changes as unknown as Prisma.InputJsonValue) : undefined,
        beforeData: before ? (this.strip(before) as Prisma.InputJsonValue) : undefined,
        reason: reason ?? null,
      },
    });
  }

  protected diff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): AuditFieldChange[] {
    const IGNORED = new Set(['updatedAt', 'createdAt', ...(this.config.hiddenFields ?? [])]);
    const changes: AuditFieldChange[] = [];

    for (const [field, newValue] of Object.entries(after)) {
      if (IGNORED.has(field)) continue;
      const oldValue = before[field];
      if (!this.equal(oldValue, newValue)) {
        changes.push({ field, from: this.serialise(oldValue), to: this.serialise(newValue) });
      }
    }
    return changes;
  }

  /** Prisma Decimal and Date need normalising before comparison. */
  private equal(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a === 'object' || typeof b === 'object') {
      return String(a) === String(b);
    }
    return false;
  }

  private serialise(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return String(value);
    return value;
  }

  /** Remove never-expose fields before the record leaves the service. */
  protected strip(record: Record<string, unknown>): Record<string, unknown> {
    const hidden = this.config.hiddenFields;
    if (!hidden?.length) return record;
    const output = { ...record };
    for (const field of hidden) delete output[field];
    return output;
  }

  protected hasField(field: string): boolean {
    const model = Prisma.dmmf.datamodel.models.find(
      (m) => m.name.toLowerCase() === this.config.model.toLowerCase(),
    );
    return model?.fields.some((f) => f.name === field) ?? false;
  }

  private lowerFirst(value: string): string {
    return value.charAt(0).toLowerCase() + value.slice(1);
  }
}
