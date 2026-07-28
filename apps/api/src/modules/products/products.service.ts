import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BaseCrudService, type CrudResourceConfig } from '../../common/crud/base-crud.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/context/request-context';

/** Price fields whose changes are recorded in PriceHistory. */
const PRICE_FIELDS = ['purchaseCost', 'sellingPrice', 'mrp', 'wholesalePrice'] as const;

@Injectable()
export class ProductsService extends BaseCrudService<Record<string, unknown>> {
  protected readonly config: CrudResourceConfig = {
    model: 'Product',
    entityType: 'Product',
    labelField: 'name',
    protectedRelations: ['salesLines', 'purchaseBillLines', 'stockMovements'],
    listInclude: {
      category: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
      supplier: { select: { id: true, companyName: true } },
    },
    detailInclude: {
      category: { select: { id: true, name: true } },
      subCategory: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
      supplier: { select: { id: true, companyName: true, code: true } },
      unit: true,
      images: { orderBy: { displayOrder: 'asc' } },
      variants: { where: { deletedAt: null } },
      allocations: { include: { shop: { select: { id: true, name: true, code: true } } } },
      priceHistory: { orderBy: { effectiveFrom: 'desc' }, take: 20 },
    },
    query: {
      searchFields: ['name', 'sku', 'barcode', 'colour', 'design', 'fabric', 'material', 'collection'],
      filterableFields: [
        'categoryId', 'subCategoryId', 'brandId', 'supplierId', 'season', 'colour',
        'size', 'fabric', 'material', 'gstRate', 'hsnCode', 'isActive',
        'totalStock', 'sellingPrice', 'createdAt',
      ],
      sortableFields: [
        'name', 'sku', 'sellingPrice', 'purchaseCost', 'mrp', 'totalStock', 'createdAt', 'updatedAt',
      ],
      dateField: 'createdAt',
      defaultSort: { field: 'name', direction: 'asc' },
    },
  };

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected override scopeWhere(user: AuthenticatedUser): Record<string, unknown> {
    return { organizationId: user.organizationId };
  }

  /**
   * Update, recording any price change.
   *
   * Margin analysis and "why was this sold at ₹450 in March?" both need the price that
   * was live on a given date, which the current row alone cannot answer.
   */
  override async update(
    user: AuthenticatedUser,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const before = await this.requireRecord(user, id);

    const priceChanges = PRICE_FIELDS.flatMap((field) => {
      if (data[field] === undefined) return [];
      const oldValue = before[field] as Prisma.Decimal | null;
      const newValue = new Prisma.Decimal(String(data[field]));
      if (oldValue && newValue.equals(oldValue)) return [];
      return [{
        productId: id,
        field,
        oldValue: oldValue ?? new Prisma.Decimal(0),
        newValue,
        reason: (data.priceChangeReason as string | undefined) ?? null,
        changedById: user.id,
      }];
    });

    // Selling price above MRP is a legal problem in India, not a warning.
    const nextSelling = data.sellingPrice ?? before.sellingPrice;
    const nextMrp = data.mrp ?? before.mrp;
    if (nextMrp && Number(nextMrp) > 0 && Number(nextSelling) > Number(nextMrp)) {
      throw new BadRequestException('Selling price cannot exceed MRP');
    }

    const { priceChangeReason: _ignored, ...payload } = data;

    return this.prisma.runInTransaction(async (tx) => {
      if (priceChanges.length > 0) {
        await tx.priceHistory.createMany({ data: priceChanges });
      }
      const record = await tx.product.update({ where: { id }, data: payload });
      await this.writeAudit(user, 'UPDATE', record as unknown as Record<string, unknown>, before);
      return this.strip(record as unknown as Record<string, unknown>);
    });
  }

  /** Per-shop stock for one product — the "where is it?" question. */
  async stockByShop(user: AuthenticatedUser, id: string) {
    await this.requireRecord(user, id);
    return this.prisma.stockItem.findMany({
      where: { productId: id },
      include: { shop: { select: { id: true, name: true, code: true } } },
      orderBy: { shop: { name: 'asc' } },
    });
  }

  /**
   * Barcode lookup for the POS. Scans hit this on every item, so it is a single indexed
   * read and deliberately returns only what the billing screen needs.
   */
  async findByBarcode(user: AuthenticatedUser, barcode: string, shopId?: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        organizationId: user.organizationId,
        deletedAt: null,
        isActive: true,
        OR: [
          { barcode },
          { sku: barcode },
          { barcodes: { some: { barcode } } },
        ],
      },
      select: {
        id: true, sku: true, name: true, hsnCode: true, gstRate: true, cessRate: true,
        sellingPrice: true, wholesalePrice: true, mrp: true, priceIncludesTax: true,
        discountPercent: true, primaryImageUrl: true, trackSerial: true,
        unit: { select: { code: true } },
        stockItems: shopId
          ? { where: { shopId }, select: { quantity: true, reservedQuantity: true, avgCost: true } }
          : false,
      },
    });

    if (!product) {
      // Also try a variant barcode before giving up — size/colour variants carry their own.
      const variant = await this.prisma.productVariant.findFirst({
        where: { OR: [{ barcode }, { sku: barcode }], deletedAt: null, isActive: true },
        include: {
          product: {
            select: {
              id: true, sku: true, name: true, hsnCode: true, gstRate: true, cessRate: true,
              sellingPrice: true, mrp: true, priceIncludesTax: true, organizationId: true,
            },
          },
        },
      });
      if (!variant || variant.product.organizationId !== user.organizationId) {
        throw new BadRequestException(`No product found for barcode ${barcode}`);
      }
      return {
        ...variant.product,
        variantId: variant.id,
        name: `${variant.product.name} — ${variant.name}`,
        sellingPrice: variant.sellingPrice ?? variant.product.sellingPrice,
        mrp: variant.mrp ?? variant.product.mrp,
      };
    }

    return product;
  }

  /** Low-stock list driving the dashboard alerts and reorder suggestions. */
  async lowStock(user: AuthenticatedUser, shopId?: string) {
    // Comparing two columns is not expressible in the Prisma query API, so this drops
    // to SQL rather than fetching every stock row and filtering in Node.
    return this.prisma.$queryRaw<Array<{
      productId: string; sku: string; name: string; shopName: string;
      quantity: Prisma.Decimal; minStock: Prisma.Decimal;
    }>>`
      SELECT p.id            AS "productId",
             p.sku,
             p.name,
             s.name          AS "shopName",
             si.quantity,
             COALESCE(psa."minStock", p."minStock") AS "minStock"
      FROM stock_items si
      JOIN products p ON p.id = si."productId"
      JOIN shops   s ON s.id = si."shopId"
      LEFT JOIN product_shop_allocations psa
             ON psa."productId" = p.id AND psa."shopId" = si."shopId"
      WHERE p."organizationId" = ${user.organizationId}
        AND p."deletedAt" IS NULL
        AND p."isActive" = true
        AND si.quantity <= COALESCE(psa."minStock", p."minStock")
        AND COALESCE(psa."minStock", p."minStock") > 0
        ${shopId ? Prisma.sql`AND si."shopId" = ${shopId}` : Prisma.empty}
      ORDER BY (si.quantity / NULLIF(COALESCE(psa."minStock", p."minStock"), 0)) ASC
      LIMIT 100
    `;
  }
}
