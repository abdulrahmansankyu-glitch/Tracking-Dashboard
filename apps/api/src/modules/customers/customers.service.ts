import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BaseCrudService, type CrudResourceConfig } from '../../common/crud/base-crud.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NumberingService } from '../../common/numbering/numbering.service';
import type { AuthenticatedUser } from '../../common/context/request-context';

@Injectable()
export class CustomersService extends BaseCrudService<Record<string, unknown>> {
  protected readonly config: CrudResourceConfig = {
    model: 'Customer',
    entityType: 'Customer',
    labelField: 'name',
    protectedRelations: ['salesInvoices'],
    query: {
      searchFields: ['name', 'phone', 'email', 'gstin', 'code', 'city'],
      filterableFields: [
        'type', 'city', 'stateCode', 'isActive', 'loyaltyTier',
        'outstandingAmount', 'totalPurchases', 'lastPurchaseAt', 'createdAt', 'birthday',
      ],
      sortableFields: [
        'name', 'code', 'createdAt', 'totalPurchases', 'outstandingAmount',
        'loyaltyPoints', 'lastPurchaseAt', 'avgOrderValue',
      ],
      dateField: 'createdAt',
      defaultSort: { field: 'name', direction: 'asc' },
    },
  };

  constructor(prisma: PrismaService, private readonly numbering: NumberingService) {
    super(prisma);
  }

  protected override scopeWhere(user: AuthenticatedUser): Record<string, unknown> {
    return { organizationId: user.organizationId };
  }

  override async create(
    user: AuthenticatedUser,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const prepared = await this.prisma.runInTransaction(async (tx) => {
      const code =
        (data.code as string | undefined) ||
        (await this.numbering.next(tx, {
          organizationId: user.organizationId,
          documentType: 'CUSTOMER',
        }));
      return { ...this.flatten(data), code };
    });
    return super.create(user, prepared);
  }

  override async update(
    user: AuthenticatedUser,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return super.update(user, id, this.flatten(data));
  }

  /** Purchase history, loyalty ledger and outstanding invoices for the customer page. */
  async profile(user: AuthenticatedUser, id: string) {
    const customer = await this.requireRecord(user, id);

    const [invoices, loyalty, wallet, favourites] = await Promise.all([
      this.prisma.salesInvoice.findMany({
        where: { customerId: id, organizationId: user.organizationId, deletedAt: null },
        orderBy: { invoiceDate: 'desc' },
        take: 25,
        select: {
          id: true, invoiceNumber: true, invoiceDate: true, grandTotal: true,
          paidAmount: true, balanceAmount: true, paymentStatus: true,
          shop: { select: { name: true, code: true } },
        },
      }),
      this.prisma.loyaltyTransaction.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      this.prisma.walletTransaction.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      // What they actually buy — drives the recommendation panel and festive campaigns.
      this.prisma.salesInvoiceLine.groupBy({
        by: ['productId'],
        where: { invoice: { customerId: id, deletedAt: null } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: 10,
      }),
    ]);

    const products = await this.prisma.product.findMany({
      where: { id: { in: favourites.map((f) => f.productId) } },
      select: { id: true, name: true, sku: true, primaryImageUrl: true },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    return {
      customer,
      invoices,
      loyaltyLedger: loyalty,
      walletLedger: wallet,
      favouriteProducts: favourites.map((row) => ({
        product: productById.get(row.productId) ?? { id: row.productId, name: 'Unknown', sku: '' },
        quantity: row._sum.quantity,
        value: row._sum.lineTotal,
      })),
      outstanding: invoices
        .filter((invoice) => invoice.paymentStatus !== 'PAID')
        .reduce((sum, invoice) => sum.add(invoice.balanceAmount), new Prisma.Decimal(0)),
    };
  }

  /**
   * Customers with a birthday or anniversary in the next `days` days.
   * Compared on month/day only — the year is the birth year, not the occasion.
   */
  async upcomingOccasions(user: AuthenticatedUser, days = 7) {
    return this.prisma.$queryRaw<Array<{
      id: string; name: string; phone: string; occasion: string; date: Date; daysAway: number;
    }>>`
      SELECT id, name, phone, occasion, date, days_away AS "daysAway"
      FROM (
        SELECT c.id, c.name, c.phone, 'Birthday' AS occasion, c.birthday AS date,
               (DATE_PART('doy', c.birthday) - DATE_PART('doy', CURRENT_DATE) + 365)::int % 365 AS days_away
        FROM customers c
        WHERE c."organizationId" = ${user.organizationId}
          AND c."deletedAt" IS NULL AND c."isActive" = true AND c.birthday IS NOT NULL
        UNION ALL
        SELECT c.id, c.name, c.phone, 'Anniversary', c.anniversary,
               (DATE_PART('doy', c.anniversary) - DATE_PART('doy', CURRENT_DATE) + 365)::int % 365
        FROM customers c
        WHERE c."organizationId" = ${user.organizationId}
          AND c."deletedAt" IS NULL AND c."isActive" = true AND c.anniversary IS NOT NULL
      ) occasions
      WHERE days_away <= ${days}
      ORDER BY days_away ASC
      LIMIT 100
    `;
  }

  private flatten(data: Record<string, unknown>): Record<string, unknown> {
    const { address, ...rest } = data as { address?: Record<string, unknown> } & Record<string, unknown>;
    if (!address) return rest;
    return {
      ...rest,
      addressLine1: address.line1 ?? null,
      addressLine2: address.line2 || null,
      city: address.city ?? null,
      district: address.district || null,
      stateCode: address.stateCode ?? null,
      pincode: address.pincode ?? null,
      country: address.country ?? 'IN',
    };
  }
}
