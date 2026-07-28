import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BaseCrudService, type CrudResourceConfig } from '../../common/crud/base-crud.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CryptoService } from '../../common/security/crypto.service';
import { NumberingService } from '../../common/numbering/numbering.service';
import type { AuthenticatedUser } from '../../common/context/request-context';

@Injectable()
export class SuppliersService extends BaseCrudService<Record<string, unknown>> {
  protected readonly config: CrudResourceConfig = {
    model: 'Supplier',
    entityType: 'Supplier',
    labelField: 'companyName',
    // Bank details are encrypted at rest and must never leave in a list payload.
    // The reveal endpoint returns them individually and logs VIEW_SENSITIVE.
    hiddenFields: ['bankAccountNumber'],
    // A supplier with purchase history is never deleted — the payables ledger and
    // every past bill reference it. Archive is the correct action.
    protectedRelations: ['purchaseOrders', 'purchaseBills', 'goodsReceipts'],
    query: {
      searchFields: ['companyName', 'ownerName', 'phone', 'email', 'gstin', 'code', 'city'],
      filterableFields: [
        'category', 'stateCode', 'city', 'isActive', 'creditPeriodDays',
        'overallRating', 'outstandingAmount', 'totalPurchaseValue', 'createdAt',
      ],
      sortableFields: [
        'companyName', 'code', 'createdAt', 'overallRating', 'totalPurchaseValue',
        'outstandingAmount', 'lateDeliveryPercent', 'creditPeriodDays',
      ],
      dateField: 'createdAt',
      defaultSort: { field: 'companyName', direction: 'asc' },
    },
  };

  constructor(
    prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly numbering: NumberingService,
  ) {
    super(prisma);
  }

  /** Suppliers are organization-wide, not per shop. */
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
          documentType: 'SUPPLIER',
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

  /**
   * Reveal a supplier's full bank account number.
   *
   * Separate from the normal read on purpose: this is the single most abuse-prone field
   * in the system (an attacker who changes a payee account redirects real money), so
   * access is deliberate, individually authorised and individually logged.
   */
  async revealBankAccount(user: AuthenticatedUser, id: string): Promise<{ accountNumber: string | null }> {
    const supplier = await this.requireRecord(user, id);

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        userName: user.name,
        action: 'VIEW_SENSITIVE',
        entityType: 'Supplier',
        entityId: id,
        entityLabel: supplier.companyName as string,
        reason: 'Viewed full bank account number',
      },
    });

    return {
      accountNumber: this.crypto.decrypt(supplier.bankAccountNumber as string | null),
    };
  }

  /** Purchase totals, outstanding balance and profit generated, for the supplier page. */
  async performance(user: AuthenticatedUser, id: string) {
    const supplier = await this.requireRecord(user, id);

    const [billAggregate, monthlyRows, topProducts] = await Promise.all([
      this.prisma.purchaseBill.aggregate({
        where: { supplierId: id, organizationId: user.organizationId, deletedAt: null },
        _sum: { grandTotal: true, paidAmount: true, balanceAmount: true },
        _count: true,
      }),

      // Monthly purchase trend. Raw SQL because Prisma cannot group by a date
      // truncation, and pulling every bill into Node to bucket it would not scale.
      this.prisma.$queryRaw<Array<{ month: Date; total: Prisma.Decimal; bills: bigint }>>`
        SELECT date_trunc('month', "billDate") AS month,
               SUM("grandTotal")               AS total,
               COUNT(*)                        AS bills
        FROM purchase_bills
        WHERE "supplierId" = ${id}
          AND "organizationId" = ${user.organizationId}
          AND "deletedAt" IS NULL
          AND "billDate" >= NOW() - INTERVAL '12 months'
        GROUP BY 1
        ORDER BY 1
      `,

      this.prisma.purchaseBillLine.groupBy({
        by: ['productId'],
        where: { bill: { supplierId: id, organizationId: user.organizationId, deletedAt: null } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: 10,
      }),
    ]);

    const productNames = await this.prisma.product.findMany({
      where: { id: { in: topProducts.map((row) => row.productId) } },
      select: { id: true, name: true, sku: true },
    });
    const nameById = new Map(productNames.map((product) => [product.id, product]));

    return {
      supplier: {
        id: supplier.id,
        companyName: supplier.companyName,
        overallRating: supplier.overallRating,
        lateDeliveryPercent: supplier.lateDeliveryPercent,
        defectPercent: supplier.defectPercent,
        creditPeriodDays: supplier.creditPeriodDays,
      },
      totals: {
        billCount: billAggregate._count,
        purchased: billAggregate._sum.grandTotal ?? new Prisma.Decimal(0),
        paid: billAggregate._sum.paidAmount ?? new Prisma.Decimal(0),
        outstanding: billAggregate._sum.balanceAmount ?? new Prisma.Decimal(0),
      },
      monthlyTrend: monthlyRows.map((row) => ({
        month: row.month,
        total: row.total,
        bills: Number(row.bills),
      })),
      topProducts: topProducts.map((row) => ({
        product: nameById.get(row.productId) ?? { id: row.productId, name: 'Unknown', sku: '' },
        quantity: row._sum.quantity,
        value: row._sum.lineTotal,
      })),
    };
  }

  /**
   * The API accepts nested `address` and `bankDetails` objects because that is how the
   * form is shaped; the table stores flat columns. Translation happens here so neither
   * side has to compromise.
   */
  private flatten(data: Record<string, unknown>): Record<string, unknown> {
    const { address, bankDetails, ...rest } = data as {
      address?: Record<string, unknown>;
      bankDetails?: Record<string, unknown>;
    } & Record<string, unknown>;

    return {
      ...rest,
      ...(address
        ? {
            addressLine1: address.line1,
            addressLine2: address.line2 || null,
            city: address.city,
            district: address.district || null,
            stateCode: address.stateCode,
            pincode: address.pincode,
            country: address.country ?? 'IN',
          }
        : {}),
      ...(bankDetails
        ? {
            bankAccountHolder: bankDetails.accountHolderName,
            bankAccountNumber: this.crypto.encrypt(bankDetails.accountNumber as string),
            bankIfsc: bankDetails.ifsc,
            bankName: bankDetails.bankName,
            bankBranch: bankDetails.branch || null,
          }
        : {}),
    };
  }
}
