import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentMode, Prisma, StockMovementType } from '@prisma/client';
import { computeTax, toPaise, toRupees, type TaxLineInput } from '@intoto/shared';

import { PrismaService } from '../../common/prisma/prisma.service';
import { NumberingService } from '../../common/numbering/numbering.service';
import { InventoryService } from '../inventory/inventory.service';
import type { AuthenticatedUser } from '../../common/context/request-context';

/**
 * Billing.
 *
 * One invoice does five things atomically: computes GST, reserves a gap-free invoice
 * number, deducts stock, captures the cost of what was sold, and records payment. If
 * any part fails the whole bill rolls back — there is no state where stock has moved
 * but no invoice exists, or an invoice exists with no stock movement.
 *
 * Tax is computed by the shared engine, the same code the POS screen runs to show the
 * running total. The cashier's screen and the filed return cannot disagree.
 */

export interface SaleLineInput {
  productId: string;
  variantId?: string;
  quantity: number;
  /** Rupees. Falls back to the product's price when omitted. */
  unitPrice?: number;
  discountPercent?: number;
  discountAmount?: number;
}

export interface CreateSaleInput {
  shopId: string;
  customerId?: string;
  walkInName?: string;
  walkInPhone?: string;
  isWholesale?: boolean;
  lines: SaleLineInput[];
  invoiceDiscount?: number;
  payments?: Array<{ mode: PaymentMode; amount: number; reference?: string }>;
  notes?: string;
  invoiceDate?: string;
}

const ZERO = new Prisma.Decimal(0);

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly inventory: InventoryService,
  ) {}

  async createInvoice(user: AuthenticatedUser, input: CreateSaleInput) {
    if (!input.lines?.length) {
      throw new BadRequestException('Add at least one item to the bill');
    }

    return this.prisma.runInTransaction(
      async (tx) => {
        // --- Shop, and the state that decides CGST+SGST vs IGST ---
        const shop = await tx.shop.findFirst({
          where: { id: input.shopId, organizationId: user.organizationId, deletedAt: null },
          select: { id: true, code: true, stateCode: true, gstin: true },
        });
        if (!shop) throw new NotFoundException('Shop not found');

        const customer = input.customerId
          ? await tx.customer.findFirst({
              where: { id: input.customerId, organizationId: user.organizationId, deletedAt: null },
              select: {
                id: true, name: true, gstin: true, stateCode: true,
                placeOfSupplyStateCode: true, type: true, loyaltyPoints: true,
              },
            })
          : null;
        if (input.customerId && !customer) throw new NotFoundException('Customer not found');

        // Place of supply defaults to the shop's own state — a walk-in buying over the
        // counter is an intra-state supply regardless of where they live.
        const placeOfSupply =
          customer?.placeOfSupplyStateCode ?? customer?.stateCode ?? shop.stateCode;

        // --- Products ---
        const productIds = [...new Set(input.lines.map((l) => l.productId))];
        const products = await tx.product.findMany({
          where: { id: { in: productIds }, organizationId: user.organizationId, deletedAt: null },
          select: {
            id: true, sku: true, name: true, hsnCode: true, gstRate: true, cessRate: true,
            sellingPrice: true, wholesalePrice: true, mrp: true, priceIncludesTax: true,
            colour: true, size: true,
            unit: { select: { code: true } },
          },
        });
        const productById = new Map(products.map((p) => [p.id, p]));

        const missing = productIds.filter((id) => !productById.has(id));
        if (missing.length) {
          throw new BadRequestException(`${missing.length} item(s) on the bill no longer exist`);
        }

        // --- Tax ---
        const wholesale = input.isWholesale ?? customer?.type === 'WHOLESALE';

        const taxLines: TaxLineInput[] = input.lines.map((line, index) => {
          const product = productById.get(line.productId)!;
          const price =
            line.unitPrice ??
            toRupees(
              toPaise(
                (wholesale && product.wholesalePrice
                  ? product.wholesalePrice
                  : product.sellingPrice
                ).toString(),
              ),
            );

          return {
            lineId: String(index),
            description: product.name,
            hsnCode: product.hsnCode,
            quantity: line.quantity,
            unitPrice: toPaise(price),
            discountAmount: line.discountAmount ? toPaise(line.discountAmount) : undefined,
            discountPercent: line.discountPercent,
            gstRate: Number(product.gstRate),
            cessRate: Number(product.cessRate),
            taxInclusive: product.priceIncludesTax,
          };
        });

        const tax = computeTax(taxLines, {
          supplierStateCode: shop.stateCode,
          placeOfSupplyStateCode: placeOfSupply,
          invoiceDiscount: input.invoiceDiscount ? toPaise(input.invoiceDiscount) : 0,
        });

        // --- Invoice number, reserved inside this transaction so the series stays
        //     unbroken even if the bill fails after this point ---
        const invoiceNumber = await this.numbering.next(tx, {
          organizationId: user.organizationId,
          documentType: 'SALES_INVOICE',
          shopId: shop.id,
          shopCode: shop.code,
        });

        const invoiceDate = input.invoiceDate ? new Date(input.invoiceDate) : new Date();
        const dec = (paise: number) => new Prisma.Decimal(toRupees(paise).toFixed(4));

        const paidAmount = (input.payments ?? []).reduce((sum, p) => sum + toPaise(p.amount), 0);
        const balance = tax.totals.grandTotal - paidAmount;

        const invoice = await tx.salesInvoice.create({
          data: {
            organizationId: user.organizationId,
            shopId: shop.id,
            invoiceNumber,
            customerId: customer?.id ?? null,
            walkInName: input.walkInName ?? null,
            walkInPhone: input.walkInPhone ?? null,
            invoiceDate,
            isWholesale: wholesale,
            supplyType: tax.supplyType,
            // Frozen on the invoice: a later change to the shop or customer record must
            // never retroactively alter a bill that has been filed in a GST return.
            supplierStateCode: shop.stateCode,
            placeOfSupplyStateCode: placeOfSupply,
            customerGstin: customer?.gstin ?? null,
            status: 'COMPLETED',
            paymentStatus: balance <= 0 ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'UNPAID',

            grossAmount: dec(tax.totals.grossAmount),
            lineDiscount: dec(tax.totals.totalDiscount),
            invoiceDiscount: dec(input.invoiceDiscount ? toPaise(input.invoiceDiscount) : 0),
            totalDiscount: dec(tax.totals.totalDiscount),
            taxableValue: dec(tax.totals.taxableValue),
            cgstAmount: dec(tax.totals.cgst),
            sgstAmount: dec(tax.totals.sgst),
            igstAmount: dec(tax.totals.igst),
            cessAmount: dec(tax.totals.cess),
            totalTax: dec(tax.totals.totalTax),
            roundOff: dec(tax.totals.roundOff),
            grandTotal: dec(tax.totals.grandTotal),
            paidAmount: dec(paidAmount),
            balanceAmount: dec(Math.max(0, balance)),

            salespersonId: user.employeeId ?? null,
            notes: input.notes ?? null,
            createdById: user.id,
          },
        });

        // --- Lines, stock and cost ---
        let totalCost = ZERO;

        for (const [index, taxLine] of tax.lines.entries()) {
          const inputLine = input.lines[index]!;
          const product = productById.get(inputLine.productId)!;

          // Deduct stock first: it throws if there is not enough, rolling the whole
          // bill back before anything is committed.
          const movement = await this.inventory.recordMovement(
            tx,
            {
              shopId: shop.id,
              productId: inputLine.productId,
              variantId: inputLine.variantId,
              type: StockMovementType.SALE,
              quantity: inputLine.quantity,
              referenceType: 'SALES_INVOICE',
              referenceId: invoice.id,
              referenceNumber: invoiceNumber,
              movementDate: invoiceDate,
            },
            user.id,
          );

          totalCost = totalCost.plus(movement.totalCost);

          await tx.salesInvoiceLine.create({
            data: {
              invoiceId: invoice.id,
              productId: inputLine.productId,
              variantId: inputLine.variantId ?? null,
              lineNumber: index + 1,
              // Copied, not referenced: this invoice must reprint identically in five
              // years even if the product is renamed or deleted.
              description: [product.name, product.colour, product.size].filter(Boolean).join(' — '),
              hsnCode: product.hsnCode,
              unitCode: product.unit?.code ?? 'PCS',
              quantity: new Prisma.Decimal(inputLine.quantity),
              unitPrice: dec(taxLine.unitPrice),
              mrp: product.mrp,
              grossAmount: dec(taxLine.grossAmount),
              discountPercent: new Prisma.Decimal(inputLine.discountPercent ?? 0),
              discountAmount: dec(taxLine.discountAmount),
              taxableValue: dec(taxLine.taxableValue),
              gstRate: new Prisma.Decimal(taxLine.gstRate),
              cgstAmount: dec(taxLine.cgst),
              sgstAmount: dec(taxLine.sgst),
              igstAmount: dec(taxLine.igst),
              cessAmount: dec(taxLine.cess),
              lineTotal: dec(taxLine.lineTotal),
              unitCost: movement.unitCost,
              totalCost: movement.totalCost,
              grossProfit: dec(taxLine.taxableValue).minus(movement.totalCost),
            },
          });
        }

        // --- Payments ---
        for (const payment of input.payments ?? []) {
          await tx.salesPayment.create({
            data: {
              invoiceId: invoice.id,
              mode: payment.mode,
              amount: new Prisma.Decimal(payment.amount.toFixed(4)),
              reference: payment.reference ?? null,
              paidAt: invoiceDate,
              createdById: user.id,
            },
          });
        }

        // --- Profit, computed from cost captured at this moment ---
        const grossProfit = dec(tax.totals.taxableValue).minus(totalCost);
        await tx.salesInvoice.update({
          where: { id: invoice.id },
          data: { costOfGoodsSold: totalCost, grossProfit },
        });

        // --- Customer running totals ---
        if (customer) {
          await tx.customer.update({
            where: { id: customer.id },
            data: {
              totalPurchases: { increment: dec(tax.totals.grandTotal) },
              totalOrders: { increment: 1 },
              outstandingAmount: { increment: dec(Math.max(0, balance)) },
              lastPurchaseAt: invoiceDate,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            userId: user.id,
            userName: user.name,
            action: 'CREATE',
            entityType: 'SalesInvoice',
            entityId: invoice.id,
            entityLabel: invoiceNumber,
            shopId: shop.id,
            changes: {
              items: input.lines.length,
              grandTotal: toRupees(tax.totals.grandTotal),
              supplyType: tax.supplyType,
            } as Prisma.InputJsonValue,
          },
        });

        return this.findOne(user, invoice.id, tx);
      },
      // A wholesale bill can run to hundreds of lines, each consuming stock.
      { timeoutMs: 60_000 },
    );
  }

  async findOne(user: AuthenticatedUser, id: string, client?: Prisma.TransactionClient) {
    const db = client ?? this.prisma;
    const invoice = await db.salesInvoice.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
      include: {
        lines: { orderBy: { lineNumber: 'asc' } },
        payments: true,
        customer: { select: { id: true, name: true, phone: true, gstin: true } },
        shop: { select: { id: true, name: true, code: true, gstin: true, addressLine1: true, city: true, stateCode: true, pincode: true, phone: true } },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  async list(
    user: AuthenticatedUser,
    params: { shopId?: string; search?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number },
  ) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 25));

    const where: Prisma.SalesInvoiceWhereInput = {
      organizationId: user.organizationId,
      deletedAt: null,
      ...(params.shopId ? { shopId: params.shopId } : {}),
      ...(!params.shopId && user.shopIds.length > 0 ? { shopId: { in: user.shopIds } } : {}),
      ...(params.search
        ? {
            OR: [
              { invoiceNumber: { contains: params.search, mode: 'insensitive' } },
              { walkInName: { contains: params.search, mode: 'insensitive' } },
              { customer: { name: { contains: params.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(params.dateFrom || params.dateTo
        ? {
            invoiceDate: {
              ...(params.dateFrom ? { gte: new Date(params.dateFrom) } : {}),
              ...(params.dateTo ? { lte: new Date(params.dateTo) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.salesInvoice.findMany({
        where,
        include: {
          customer: { select: { name: true, phone: true } },
          shop: { select: { name: true, code: true } },
          _count: { select: { lines: true } },
        },
        orderBy: { invoiceDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.salesInvoice.count({ where }),
    ]);

    return {
      data,
      meta: {
        page, pageSize, total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        hasNext: page * pageSize < total,
        hasPrevious: page > 1,
      },
    };
  }

  /**
   * Void an invoice: reverse the stock and mark it cancelled.
   *
   * The invoice is never deleted. GST requires the number series to stay unbroken, so a
   * cancelled bill remains visible and reportable with its reason attached.
   */
  async voidInvoice(user: AuthenticatedUser, id: string, reason: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to void an invoice');
    }

    return this.prisma.runInTransaction(async (tx) => {
      const invoice = await tx.salesInvoice.findFirst({
        where: { id, organizationId: user.organizationId, deletedAt: null },
        include: { lines: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.voidedAt) throw new BadRequestException('This invoice is already void');

      for (const line of invoice.lines) {
        await this.inventory.recordMovement(
          tx,
          {
            shopId: invoice.shopId,
            productId: line.productId,
            variantId: line.variantId,
            type: StockMovementType.SALES_RETURN,
            quantity: line.quantity,
            unitCost: line.unitCost,
            referenceType: 'VOID_INVOICE',
            referenceId: invoice.id,
            referenceNumber: invoice.invoiceNumber,
            notes: `Void: ${reason}`,
          },
          user.id,
        );
      }

      if (invoice.customerId) {
        await tx.customer.update({
          where: { id: invoice.customerId },
          data: {
            totalPurchases: { decrement: invoice.grandTotal },
            totalOrders: { decrement: 1 },
            outstandingAmount: { decrement: invoice.balanceAmount },
          },
        });
      }

      const updated = await tx.salesInvoice.update({
        where: { id },
        data: {
          status: 'VOID',
          voidedAt: new Date(),
          voidReason: reason,
          voidedById: user.id,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          userName: user.name,
          action: 'VOID',
          entityType: 'SalesInvoice',
          entityId: id,
          entityLabel: invoice.invoiceNumber,
          shopId: invoice.shopId,
          reason,
        },
      });

      return updated;
    });
  }

  /** Today's numbers for the dashboard and the daily close. */
  async summary(user: AuthenticatedUser, params: { shopId?: string; date?: string }) {
    const day = params.date ? new Date(params.date) : new Date();
    const start = new Date(day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(day);
    end.setHours(23, 59, 59, 999);

    const shopFilter = params.shopId
      ? { shopId: params.shopId }
      : user.shopIds.length > 0
        ? { shopId: { in: user.shopIds } }
        : {};

    const base: Prisma.SalesInvoiceWhereInput = {
      organizationId: user.organizationId,
      deletedAt: null,
      status: { not: 'VOID' },
      ...shopFilter,
    };

    const monthStart = new Date(day.getFullYear(), day.getMonth(), 1);

    const [today, month, byMode, topProducts] = await Promise.all([
      this.prisma.salesInvoice.aggregate({
        where: { ...base, invoiceDate: { gte: start, lte: end } },
        _sum: { grandTotal: true, grossProfit: true, balanceAmount: true },
        _count: true,
      }),
      this.prisma.salesInvoice.aggregate({
        where: { ...base, invoiceDate: { gte: monthStart, lte: end } },
        _sum: { grandTotal: true, grossProfit: true },
        _count: true,
      }),
      this.prisma.salesPayment.groupBy({
        by: ['mode'],
        where: { invoice: { ...base, invoiceDate: { gte: start, lte: end } } },
        _sum: { amount: true },
      }),
      this.prisma.salesInvoiceLine.groupBy({
        by: ['productId'],
        where: { invoice: { ...base, invoiceDate: { gte: monthStart, lte: end } } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: 6,
      }),
    ]);

    const products = await this.prisma.product.findMany({
      where: { id: { in: topProducts.map((p) => p.productId) } },
      select: { id: true, name: true, sku: true, category: { select: { name: true } } },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    return {
      today: {
        sales: today._sum.grandTotal ?? ZERO,
        profit: today._sum.grossProfit ?? ZERO,
        outstanding: today._sum.balanceAmount ?? ZERO,
        invoiceCount: today._count,
      },
      month: {
        sales: month._sum.grandTotal ?? ZERO,
        profit: month._sum.grossProfit ?? ZERO,
        invoiceCount: month._count,
      },
      paymentModes: byMode.map((row) => ({ mode: row.mode, amount: row._sum.amount ?? ZERO })),
      topProducts: topProducts.map((row) => ({
        product: productById.get(row.productId) ?? { id: row.productId, name: 'Unknown', sku: '' },
        quantity: row._sum.quantity ?? ZERO,
        revenue: row._sum.lineTotal ?? ZERO,
      })),
    };
  }
}
