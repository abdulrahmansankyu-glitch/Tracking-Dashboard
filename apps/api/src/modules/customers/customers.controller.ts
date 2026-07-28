import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { customerSchema } from '@intoto/shared';

import { createCrudController } from '../../common/crud/crud.controller';
import { CurrentUser, RequirePermissions, SkipAudit } from '../../common/decorators';
import type { ExportColumn } from '../../common/export/export.service';
import { importCoercions, type ImportColumn } from '../../common/import/import.service';
import type { AuthenticatedUser } from '../../common/context/request-context';
import { CustomersService } from './customers.service';

const exportColumns: ExportColumn[] = [
  { key: 'code', header: 'Code', width: 12 },
  { key: 'name', header: 'Customer Name', width: 28 },
  { key: 'type', header: 'Type', width: 12 },
  { key: 'phone', header: 'Phone', width: 14 },
  { key: 'email', header: 'Email', width: 26 },
  { key: 'gstin', header: 'GSTIN', width: 18 },
  { key: 'city', header: 'City', width: 16 },
  { key: 'totalPurchases', header: 'Lifetime Value', format: 'currency' },
  { key: 'totalOrders', header: 'Orders', format: 'number', width: 10 },
  { key: 'avgOrderValue', header: 'Avg Order', format: 'currency' },
  { key: 'outstandingAmount', header: 'Outstanding', format: 'currency' },
  { key: 'loyaltyPoints', header: 'Points', format: 'number', width: 10 },
  { key: 'loyaltyTier', header: 'Tier', width: 12 },
  { key: 'lastPurchaseAt', header: 'Last Purchase', format: 'date' },
  { key: 'isActive', header: 'Active', format: 'boolean', width: 9 },
];

const importColumns: ImportColumn[] = [
  { header: 'Customer Name', field: 'name', required: true, schema: importCoercions.text },
  { header: 'Phone', field: 'phone', required: true, schema: importCoercions.text },
  { header: 'Email', field: 'email', schema: importCoercions.text },
  { header: 'Type', field: 'type', schema: importCoercions.text },
  { header: 'GSTIN', field: 'gstin', schema: importCoercions.text },
  { header: 'City', field: 'city', schema: importCoercions.text },
  { header: 'State Code', field: 'stateCode', schema: importCoercions.text },
  { header: 'Pincode', field: 'pincode', schema: importCoercions.text },
  { header: 'Credit Limit', field: 'creditLimit', schema: importCoercions.positiveDecimal },
  { header: 'Credit Days', field: 'creditPeriodDays', schema: importCoercions.integer },
];

/** List, create, update, delete, archive, restore, export, import, history. */
export const CustomersCrudController = createCrudController<CustomersService>({
  serviceClass: CustomersService,
  path: 'customers',
  tag: 'Customers',
  resource: 'customer',
  entityType: 'Customer',
  labelField: 'name',
  createSchema: customerSchema,
  updateSchema: customerSchema.partial(),
  exportColumns,
  importColumns,
});

/**
 * Routes specific to customers. Shares the `customers` path with the generated CRUD
 * controller; registered first so these paths are matched before the generic `:id`.
 */
@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('occasions/upcoming')
  @RequirePermissions('customer:read')
  @SkipAudit()
  @ApiOperation({ summary: 'Birthdays and anniversaries in the next N days' })
  @ApiQuery({ name: 'days', required: false, example: 7 })
  occasions(@Query('days') days: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.upcomingOccasions(
      user,
      days ? Number.parseInt(days, 10) : 7,
    );
  }

  @Get(':id/profile')
  @RequirePermissions('customer:read')
  @SkipAudit()
  @ApiOperation({ summary: 'Purchase history, loyalty ledger, wallet and favourite products' })
  profile(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.profile(user, id);
  }
}
