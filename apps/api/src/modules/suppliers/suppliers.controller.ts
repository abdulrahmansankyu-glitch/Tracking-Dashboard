import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { supplierSchema } from '@intoto/shared';

import { createCrudController } from '../../common/crud/crud.controller';
import { CurrentUser, RequirePermissions, SkipAudit } from '../../common/decorators';
import type { ExportColumn } from '../../common/export/export.service';
import { importCoercions, type ImportColumn } from '../../common/import/import.service';
import type { AuthenticatedUser } from '../../common/context/request-context';
import { SuppliersService } from './suppliers.service';

const exportColumns: ExportColumn[] = [
  { key: 'code', header: 'Code', width: 12 },
  { key: 'companyName', header: 'Company Name', width: 32 },
  { key: 'ownerName', header: 'Owner', width: 22 },
  { key: 'gstin', header: 'GSTIN', width: 18 },
  { key: 'pan', header: 'PAN', width: 13 },
  { key: 'phone', header: 'Phone', width: 14 },
  { key: 'email', header: 'Email', width: 28 },
  { key: 'city', header: 'City', width: 16 },
  { key: 'stateCode', header: 'State', width: 8 },
  { key: 'category', header: 'Category', width: 16 },
  { key: 'creditPeriodDays', header: 'Credit Days', format: 'number', width: 12 },
  { key: 'totalPurchaseValue', header: 'Total Purchased', format: 'currency' },
  { key: 'outstandingAmount', header: 'Outstanding', format: 'currency' },
  { key: 'overallRating', header: 'Rating', format: 'number', decimals: 2, width: 10 },
  { key: 'lateDeliveryPercent', header: 'Late Delivery %', format: 'percent' },
  { key: 'isActive', header: 'Active', format: 'boolean', width: 9 },
  { key: 'createdAt', header: 'Added On', format: 'date' },
];

const importColumns: ImportColumn[] = [
  { header: 'Company Name', field: 'companyName', required: true, schema: importCoercions.text },
  { header: 'Owner', field: 'ownerName', schema: importCoercions.text },
  { header: 'Phone', field: 'phone', required: true, schema: importCoercions.text },
  { header: 'Email', field: 'email', schema: importCoercions.text },
  { header: 'GSTIN', field: 'gstin', schema: importCoercions.text },
  { header: 'PAN', field: 'pan', schema: importCoercions.text },
  { header: 'City', field: 'city', schema: importCoercions.text },
  { header: 'State Code', field: 'stateCode', schema: importCoercions.text },
  { header: 'Pincode', field: 'pincode', schema: importCoercions.text },
  { header: 'Category', field: 'category', schema: importCoercions.text },
  { header: 'Credit Days', field: 'creditPeriodDays', schema: importCoercions.integer },
];

/** List, create, update, delete, archive, restore, export, import, history. */
export const SuppliersCrudController = createCrudController<SuppliersService>({
  serviceClass: SuppliersService,
  path: 'suppliers',
  tag: 'Suppliers',
  resource: 'supplier',
  entityType: 'Supplier',
  labelField: 'companyName',
  createSchema: supplierSchema,
  // Every field optional on update so a form can PATCH just what changed.
  updateSchema: supplierSchema.partial(),
  exportColumns,
  importColumns,
});

/**
 * Routes specific to suppliers. Shares the `suppliers` path with the generated CRUD
 * controller; registered first in the module so these more specific paths are matched
 * before the generic `:id`.
 */
@ApiTags('Suppliers')
@ApiBearerAuth()
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get(':id/performance')
  @RequirePermissions('supplier:read')
  @SkipAudit()
  @ApiOperation({ summary: 'Purchase totals, monthly trend and top products supplied' })
  performance(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.suppliers.performance(user, id);
  }

  @Get(':id/bank-account')
  @RequirePermissions('supplier:read')
  @ApiOperation({ summary: 'Reveal the full bank account number — logged as a sensitive view' })
  revealBankAccount(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.suppliers.revealBankAccount(user, id);
  }
}
