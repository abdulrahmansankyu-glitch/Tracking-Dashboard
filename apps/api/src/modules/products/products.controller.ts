import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { productBaseSchema, productSchema } from '@intoto/shared';

import { createCrudController } from '../../common/crud/crud.controller';
import { CurrentUser, RequirePermissions, SkipAudit } from '../../common/decorators';
import type { ExportColumn } from '../../common/export/export.service';
import { importCoercions, type ImportColumn } from '../../common/import/import.service';
import type { AuthenticatedUser } from '../../common/context/request-context';
import { ProductsService } from './products.service';

const exportColumns: ExportColumn[] = [
  { key: 'sku', header: 'SKU', width: 16 },
  { key: 'name', header: 'Product Name', width: 34 },
  { key: 'category.name', header: 'Category', width: 18 },
  { key: 'brand.name', header: 'Brand', width: 16 },
  { key: 'supplier.companyName', header: 'Supplier', width: 26 },
  { key: 'colour', header: 'Colour', width: 14 },
  { key: 'size', header: 'Size', width: 10 },
  { key: 'fabric', header: 'Fabric', width: 16 },
  { key: 'hsnCode', header: 'HSN', width: 10 },
  { key: 'gstRate', header: 'GST %', format: 'percent', width: 9 },
  { key: 'purchaseCost', header: 'Cost', format: 'currency' },
  { key: 'sellingPrice', header: 'Selling Price', format: 'currency' },
  { key: 'mrp', header: 'MRP', format: 'currency' },
  { key: 'totalStock', header: 'Stock', format: 'number', decimals: 2 },
  { key: 'minStock', header: 'Min Stock', format: 'number', decimals: 2 },
  { key: 'isActive', header: 'Active', format: 'boolean', width: 9 },
];

const importColumns: ImportColumn[] = [
  { header: 'SKU', field: 'sku', required: true, schema: importCoercions.text },
  { header: 'Product Name', field: 'name', required: true, schema: importCoercions.text },
  { header: 'Barcode', field: 'barcode', schema: importCoercions.text },
  { header: 'Colour', field: 'colour', schema: importCoercions.text },
  { header: 'Size', field: 'size', schema: importCoercions.text },
  { header: 'Fabric', field: 'fabric', schema: importCoercions.text },
  { header: 'HSN Code', field: 'hsnCode', schema: importCoercions.text },
  { header: 'GST Rate', field: 'gstRate', schema: importCoercions.positiveDecimal },
  { header: 'Purchase Cost', field: 'purchaseCost', schema: importCoercions.positiveDecimal },
  { header: 'Selling Price', field: 'sellingPrice', schema: importCoercions.positiveDecimal },
  { header: 'MRP', field: 'mrp', schema: importCoercions.positiveDecimal },
  { header: 'Min Stock', field: 'minStock', schema: importCoercions.positiveDecimal },
];

/** List, create, update, delete, archive, restore, export, import, history. */
export const ProductsCrudController = createCrudController<ProductsService>({
  serviceClass: ProductsService,
  path: 'products',
  tag: 'Products',
  resource: 'product',
  entityType: 'Product',
  labelField: 'name',
  createSchema: productSchema,
  // productSchema carries cross-field refinements (ZodEffects), which has no
  // `.partial()`. The MRP rule is re-checked against the merged record in
  // ProductsService.update, so a PATCH is still validated.
  updateSchema: productBaseSchema.partial(),
  exportColumns,
  importColumns,
});

/**
 * Routes specific to products. Shares the `products` path with the generated CRUD
 * controller; registered first so these paths are matched before the generic `:id`.
 */
@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get('lookup/barcode/:barcode')
  @RequirePermissions('product:read')
  @SkipAudit()
  @ApiOperation({ summary: 'POS barcode/SKU lookup — matches products and variants' })
  @ApiQuery({ name: 'shopId', required: false })
  lookup(
    @Param('barcode') barcode: string,
    @Query('shopId') shopId: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.products.findByBarcode(user, barcode, shopId);
  }

  @Get('alerts/low-stock')
  @RequirePermissions('product:read')
  @SkipAudit()
  @ApiOperation({ summary: 'Products at or below their minimum stock level' })
  @ApiQuery({ name: 'shopId', required: false })
  lowStock(@Query('shopId') shopId: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.products.lowStock(user, shopId);
  }

  @Get(':id/stock')
  @RequirePermissions('product:read')
  @SkipAudit()
  @ApiOperation({ summary: 'Stock held for this product at each shop' })
  stock(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.products.stockByShop(user, id);
  }
}
