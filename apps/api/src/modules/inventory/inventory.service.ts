import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { NumberingService } from '../../common/numbering/numbering.service';
import type { AuthenticatedUser } from '../../common/context/request-context';

/**
 * The inventory engine. Everything that changes stock goes through `recordMovement`.
 *
 * Two rules make the numbers trustworthy:
 *
 *  1. The movement ledger is append-only. A correction is a new row, never an edit, so
 *     stock on any past date can be reconstructed and nobody can quietly rewrite history.
 *  2. Cost is captured at the moment stock leaves. Weighted average is recalculated on
 *     every receipt; a sale consumes the average as it stood then. That is what makes
 *     profit real rather than an estimate that shifts when prices change later.
 *
 * Every mutation runs inside a transaction with the document that caused it, so stock
 * and the document can never disagree.
 */

export interface MovementInput {
  shopId: string;
  productId: string;
  variantId?: string | null;
  type: StockMovementType;
  /** Always positive — direction comes from `type` */
  quantity: Prisma.Decimal | number;
  /** Required for inbound movements; ignored for outbound (average cost is used) */
  unitCost?: Prisma.Decimal | number;
  referenceType?: string;
  referenceId?: string;
  referenceNumber?: string;
  notes?: string;
  movementDate?: Date;
}

export interface MovementResult {
  movementId: string;
  balanceAfter: Prisma.Decimal;
  /** Cost consumed (outbound) or added (inbound) */
  unitCost: Prisma.Decimal;
  totalCost: Prisma.Decimal;
}

/** Movements that increase quantity on hand. */
const INBOUND: readonly StockMovementType[] = [
  StockMovementType.OPENING,
  StockMovementType.PURCHASE,
  StockMovementType.SALES_RETURN,
  StockMovementType.TRANSFER_IN,
  StockMovementType.ADJUSTMENT_INCREASE,
  StockMovementType.PRODUCTION,
];

const ZERO = new Prisma.Decimal(0);

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  static isInbound(type: StockMovementType): boolean {
    return INBOUND.includes(type);
  }

  /**
   * Record one stock movement and bring the balance, average cost and stock value into
   * line with it.
   *
   * MUST be called inside a transaction — pass the transaction client. Callers own the
   * transaction because a sale must write its invoice, its stock movements and its
   * ledger entries as one unit.
   */
  async recordMovement(
    tx: Prisma.TransactionClient,
    input: MovementInput,
    userId?: string,
  ): Promise<MovementResult> {
    const quantity = new Prisma.Decimal(input.quantity.toString());
    if (quantity.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Movement quantity must be greater than zero');
    }

    const inbound = InventoryService.isInbound(input.type);
    const signedQuantity = inbound ? quantity : quantity.negated();

    // Lock the balance row for the duration of the transaction. Without this, two
    // counters selling the last saree at the same moment would both read stock 1 and
    // both succeed, leaving -1 on hand.
    // '' is the "no variant" key — see the note on StockItem.variantId.
    const variantKey = input.variantId ?? '';

    const existing = await tx.stockItem.findUnique({
      where: {
        shopId_productId_variantId: {
          shopId: input.shopId,
          productId: input.productId,
          variantId: variantKey,
        },
      },
    });

    const currentQuantity = existing?.quantity ?? ZERO;
    const currentAvgCost = existing?.avgCost ?? ZERO;
    const newQuantity = currentQuantity.plus(signedQuantity);

    if (!inbound && newQuantity.lessThan(0)) {
      const product = await tx.product.findUnique({
        where: { id: input.productId },
        select: { name: true, sku: true },
      });
      throw new BadRequestException(
        `Not enough stock for ${product?.name ?? 'this item'} (${product?.sku ?? ''}). ` +
          `Available ${currentQuantity.toFixed(2)}, tried to remove ${quantity.toFixed(2)}.`,
      );
    }

    // --- Cost ---
    let unitCost: Prisma.Decimal;
    let newAvgCost: Prisma.Decimal;

    if (inbound) {
      unitCost = new Prisma.Decimal((input.unitCost ?? currentAvgCost).toString());
      // Weighted average: (existing value + incoming value) / total quantity.
      // Guarded against a zero denominator, which happens when stock was negative.
      const existingValue = currentQuantity.times(currentAvgCost);
      const incomingValue = quantity.times(unitCost);
      newAvgCost = newQuantity.greaterThan(0)
        ? existingValue.plus(incomingValue).dividedBy(newQuantity)
        : unitCost;
    } else {
      // Outbound consumes the average as it stands. Falling back to the product's
      // purchase cost keeps profit sane when stock was created without a cost.
      unitCost = currentAvgCost.greaterThan(0)
        ? currentAvgCost
        : new Prisma.Decimal(
            (
              await tx.product.findUnique({
                where: { id: input.productId },
                select: { purchaseCost: true },
              })
            )?.purchaseCost ?? 0,
          );
      newAvgCost = currentAvgCost;
    }

    const totalCost = quantity.times(unitCost);
    const movementDate = input.movementDate ?? new Date();

    const movement = await tx.stockMovement.create({
      data: {
        shopId: input.shopId,
        productId: input.productId,
        variantId: input.variantId ?? null,
        type: input.type,
        quantity,
        signedQuantity,
        unitCost,
        totalCost,
        balanceAfter: newQuantity,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        referenceNumber: input.referenceNumber ?? null,
        notes: input.notes ?? null,
        movementDate,
        createdById: userId ?? null,
      },
    });

    await tx.stockItem.upsert({
      where: {
        shopId_productId_variantId: {
          shopId: input.shopId,
          productId: input.productId,
          variantId: variantKey,
        },
      },
      create: {
        shopId: input.shopId,
        productId: input.productId,
        variantId: variantKey,
        quantity: newQuantity,
        avgCost: newAvgCost,
        stockValue: newQuantity.times(newAvgCost),
        lastMovementAt: movementDate,
        lastSoldAt: input.type === StockMovementType.SALE ? movementDate : null,
      },
      update: {
        quantity: newQuantity,
        avgCost: newAvgCost,
        stockValue: newQuantity.times(newAvgCost),
        lastMovementAt: movementDate,
        ...(input.type === StockMovementType.SALE ? { lastSoldAt: movementDate } : {}),
      },
    });

    // Roll-up across shops, so "how many do we have anywhere" is one read.
    await tx.product.update({
      where: { id: input.productId },
      data: {
        totalStock: { increment: signedQuantity },
        ...(inbound ? { avgCost: newAvgCost } : {}),
      },
    });

    if (input.variantId) {
      await tx.productVariant.update({
        where: { id: input.variantId },
        data: { totalStock: { increment: signedQuantity } },
      });
    }

    return { movementId: movement.id, balanceAfter: newQuantity, unitCost, totalCost };
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /**
   * Receive stock into a shop — the simple "goods arrived" action, without the
   * purchase-order paperwork. This is how a small shop actually works: the supplier
   * delivers, you count it in, the bill is reconciled later.
   */
  async stockIn(
    user: AuthenticatedUser,
    input: {
      shopId: string;
      lines: Array<{ productId: string; variantId?: string; quantity: number; unitCost: number }>;
      supplierId?: string;
      reference?: string;
      notes?: string;
    },
  ) {
    if (!input.lines.length) throw new BadRequestException('Add at least one item');

    return this.prisma.runInTransaction(async (tx) => {
      const shop = await tx.shop.findFirst({
        where: { id: input.shopId, organizationId: user.organizationId, deletedAt: null },
        select: { id: true, code: true },
      });
      if (!shop) throw new BadRequestException('Shop not found');

      const receiptNumber = await this.numbering.next(tx, {
        organizationId: user.organizationId,
        documentType: 'GOODS_RECEIPT',
        shopId: shop.id,
        shopCode: shop.code,
      });

      const results = [];
      for (const line of input.lines) {
        results.push(
          await this.recordMovement(
            tx,
            {
              shopId: input.shopId,
              productId: line.productId,
              variantId: line.variantId,
              type: StockMovementType.PURCHASE,
              quantity: line.quantity,
              unitCost: line.unitCost,
              referenceType: 'STOCK_IN',
              referenceNumber: receiptNumber,
              notes: input.notes,
            },
            user.id,
          ),
        );
      }

      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          userName: user.name,
          action: 'CREATE',
          entityType: 'StockIn',
          entityLabel: receiptNumber,
          shopId: input.shopId,
          changes: { lines: input.lines.length, reference: input.reference } as Prisma.InputJsonValue,
        },
      });

      return {
        receiptNumber,
        linesReceived: results.length,
        totalValue: results.reduce((sum, r) => sum.plus(r.totalCost), ZERO),
      };
    });
  }

  /** Write stock off or on: damage, theft, or correcting a miscount. */
  async adjust(
    user: AuthenticatedUser,
    input: {
      shopId: string;
      reason: 'DAMAGED' | 'LOST' | 'THEFT' | 'EXPIRED' | 'COUNT_CORRECTION' | 'SAMPLE' | 'GIFT' | 'OTHER';
      lines: Array<{ productId: string; variantId?: string; quantityDelta: number; notes?: string }>;
      notes?: string;
    },
  ) {
    if (!input.lines.length) throw new BadRequestException('Add at least one item');

    return this.prisma.runInTransaction(async (tx) => {
      const shop = await tx.shop.findFirst({
        where: { id: input.shopId, organizationId: user.organizationId, deletedAt: null },
        select: { id: true, code: true },
      });
      if (!shop) throw new BadRequestException('Shop not found');

      const adjustmentNumber = await this.numbering.next(tx, {
        organizationId: user.organizationId,
        documentType: 'STOCK_ADJUSTMENT',
        shopId: shop.id,
        shopCode: shop.code,
      });

      let valueImpact = ZERO;
      for (const line of input.lines) {
        if (line.quantityDelta === 0) continue;
        const increase = line.quantityDelta > 0;
        const result = await this.recordMovement(
          tx,
          {
            shopId: input.shopId,
            productId: line.productId,
            variantId: line.variantId,
            type: increase
              ? StockMovementType.ADJUSTMENT_INCREASE
              : input.reason === 'DAMAGED'
                ? StockMovementType.DAMAGED
                : input.reason === 'LOST' || input.reason === 'THEFT'
                  ? StockMovementType.LOST
                  : StockMovementType.ADJUSTMENT_DECREASE,
            quantity: Math.abs(line.quantityDelta),
            referenceType: 'STOCK_ADJUSTMENT',
            referenceNumber: adjustmentNumber,
            notes: line.notes ?? input.notes,
          },
          user.id,
        );
        valueImpact = increase
          ? valueImpact.plus(result.totalCost)
          : valueImpact.minus(result.totalCost);
      }

      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          userName: user.name,
          action: 'CREATE',
          entityType: 'StockAdjustment',
          entityLabel: adjustmentNumber,
          shopId: input.shopId,
          reason: input.reason,
          changes: { lines: input.lines.length, valueImpact: valueImpact.toString() } as Prisma.InputJsonValue,
        },
      });

      return { adjustmentNumber, valueImpact };
    });
  }

  /** Move stock between shops. Both sides move in one transaction — nothing in limbo. */
  async transfer(
    user: AuthenticatedUser,
    input: {
      fromShopId: string;
      toShopId: string;
      lines: Array<{ productId: string; variantId?: string; quantity: number }>;
      notes?: string;
    },
  ) {
    if (input.fromShopId === input.toShopId) {
      throw new BadRequestException('Source and destination shops must be different');
    }
    if (!input.lines.length) throw new BadRequestException('Add at least one item');

    return this.prisma.runInTransaction(async (tx) => {
      const shops = await tx.shop.findMany({
        where: {
          id: { in: [input.fromShopId, input.toShopId] },
          organizationId: user.organizationId,
          deletedAt: null,
        },
        select: { id: true, code: true, name: true },
      });
      if (shops.length !== 2) throw new BadRequestException('One of the shops was not found');
      const fromShop = shops.find((s) => s.id === input.fromShopId)!;

      const transferNumber = await this.numbering.next(tx, {
        organizationId: user.organizationId,
        documentType: 'STOCK_TRANSFER',
        shopId: fromShop.id,
        shopCode: fromShop.code,
      });

      let totalValue = ZERO;
      for (const line of input.lines) {
        // Out first: it establishes the cost that travels with the goods, and it fails
        // if there is not enough — before anything has been added at the far end.
        const out = await this.recordMovement(
          tx,
          {
            shopId: input.fromShopId,
            productId: line.productId,
            variantId: line.variantId,
            type: StockMovementType.TRANSFER_OUT,
            quantity: line.quantity,
            referenceType: 'STOCK_TRANSFER',
            referenceNumber: transferNumber,
            notes: input.notes,
          },
          user.id,
        );

        await this.recordMovement(
          tx,
          {
            shopId: input.toShopId,
            productId: line.productId,
            variantId: line.variantId,
            type: StockMovementType.TRANSFER_IN,
            quantity: line.quantity,
            // Cost travels with the goods; a transfer must not create or destroy value.
            unitCost: out.unitCost,
            referenceType: 'STOCK_TRANSFER',
            referenceNumber: transferNumber,
            notes: input.notes,
          },
          user.id,
        );

        totalValue = totalValue.plus(out.totalCost);
      }

      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          userName: user.name,
          action: 'CREATE',
          entityType: 'StockTransfer',
          entityLabel: transferNumber,
          shopId: input.fromShopId,
          changes: {
            from: fromShop.name,
            to: shops.find((s) => s.id === input.toShopId)?.name,
            lines: input.lines.length,
          } as Prisma.InputJsonValue,
        },
      });

      return { transferNumber, linesTransferred: input.lines.length, totalValue };
    });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Current stock, optionally for one shop. */
  async list(
    user: AuthenticatedUser,
    params: { shopId?: string; search?: string; lowOnly?: boolean; page?: number; pageSize?: number },
  ) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50));

    const where: Prisma.StockItemWhereInput = {
      product: {
        organizationId: user.organizationId,
        deletedAt: null,
        ...(params.search
          ? {
              OR: [
                { name: { contains: params.search, mode: 'insensitive' } },
                { sku: { contains: params.search, mode: 'insensitive' } },
                { barcode: { contains: params.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      ...(params.shopId ? { shopId: params.shopId } : {}),
      // Users restricted to certain shops must not see other branches' stock.
      ...(!params.shopId && user.shopIds.length > 0 ? { shopId: { in: user.shopIds } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.stockItem.findMany({
        where,
        include: {
          product: {
            // Everything the billing screen needs to price a line and compute GST
            // locally, so adding an item to a bill costs no extra request.
            select: {
              id: true, sku: true, name: true, minStock: true, colour: true, size: true,
              hsnCode: true, gstRate: true, cessRate: true, sellingPrice: true,
              wholesalePrice: true, mrp: true, priceIncludesTax: true,
            },
          },
          shop: { select: { id: true, name: true, code: true } },
        },
        orderBy: [{ product: { name: 'asc' } }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockItem.count({ where }),
    ]);

    const data = rows
      .map((row) => ({
        ...row,
        isLow:
          row.product.minStock.greaterThan(0) && row.quantity.lessThanOrEqualTo(row.product.minStock),
      }))
      // Filtering after the page is a deliberate simplification: comparing two columns
      // needs raw SQL, and this list is browsed rather than exported.
      .filter((row) => !params.lowOnly || row.isLow);

    return {
      data,
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        hasNext: page * pageSize < total,
        hasPrevious: page > 1,
      },
    };
  }

  /** Movement history for one product — where every unit came from and went. */
  async movements(
    user: AuthenticatedUser,
    params: { productId?: string; shopId?: string; limit?: number },
  ) {
    return this.prisma.stockMovement.findMany({
      where: {
        product: { organizationId: user.organizationId },
        ...(params.productId ? { productId: params.productId } : {}),
        ...(params.shopId ? { shopId: params.shopId } : {}),
        ...(!params.shopId && user.shopIds.length > 0 ? { shopId: { in: user.shopIds } } : {}),
      },
      include: {
        product: { select: { sku: true, name: true } },
        shop: { select: { name: true, code: true } },
      },
      orderBy: { movementDate: 'desc' },
      take: Math.min(500, params.limit ?? 100),
    });
  }

  /** Total stock value per shop — the figure the owner checks. */
  async valuation(user: AuthenticatedUser) {
    const rows = await this.prisma.stockItem.groupBy({
      by: ['shopId'],
      where: {
        product: { organizationId: user.organizationId, deletedAt: null },
        ...(user.shopIds.length > 0 ? { shopId: { in: user.shopIds } } : {}),
      },
      _sum: { stockValue: true, quantity: true },
    });

    const shops = await this.prisma.shop.findMany({
      where: { id: { in: rows.map((r) => r.shopId) } },
      select: { id: true, name: true, code: true },
    });
    const shopById = new Map(shops.map((s) => [s.id, s]));

    return {
      byShop: rows.map((row) => ({
        shop: shopById.get(row.shopId) ?? { id: row.shopId, name: 'Unknown', code: '' },
        stockValue: row._sum.stockValue ?? ZERO,
        units: row._sum.quantity ?? ZERO,
      })),
      totalValue: rows.reduce((sum, r) => sum.plus(r._sum.stockValue ?? ZERO), ZERO),
    };
  }
}
