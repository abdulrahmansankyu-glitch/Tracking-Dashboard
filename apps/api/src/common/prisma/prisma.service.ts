import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma client wrapper.
 *
 * Adds three things the plain client does not give us:
 *
 *  1. Slow-query logging — a 400ms query on the POS is a customer waiting at the
 *     counter, so it gets surfaced rather than buried.
 *  2. `softDeleteWhere` / tenant helpers used by every service, so "exclude deleted
 *     rows" is written once instead of in 200 places.
 *  3. `transaction()` with a longer timeout, because posting an invoice touches stock,
 *     ledgers, loyalty and accounting in one atomic unit.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      errorFormat: 'pretty',
    });
  }

  async onModuleInit(): Promise<void> {
    // @ts-expect-error — Prisma's typed event map does not narrow with the array form
    this.$on('query', (event: Prisma.QueryEvent) => {
      if (event.duration >= 400) {
        this.logger.warn(`Slow query (${event.duration}ms): ${event.query.slice(0, 300)}`);
      }
    });
    // @ts-expect-error — see above
    this.$on('error', (event: Prisma.LogEvent) => this.logger.error(event.message));

    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run work atomically. The default Prisma timeout (5s) is too tight for a wholesale
   * invoice with 200 lines, each consuming FIFO cost layers.
   */
  runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    return this.$transaction(fn, {
      maxWait: 10_000,
      timeout: options?.timeoutMs ?? 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  /** Standard "visible rows" filter: not soft-deleted, and archived only when asked. */
  static visibilityWhere(options?: { includeArchived?: boolean; onlyArchived?: boolean }) {
    if (options?.onlyArchived) {
      return { deletedAt: null, archivedAt: { not: null } };
    }
    if (options?.includeArchived) {
      return { deletedAt: null };
    }
    return { deletedAt: null, archivedAt: null };
  }

  /** Truncate every business table. Test-suite use only — refuses to run in production. */
  async resetForTests(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('resetForTests() must never run against production');
    }
    const tables = await this.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
    `;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    if (list) {
      await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
    }
  }
}
