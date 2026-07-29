import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';

import { BaseCrudService, type CrudResourceConfig } from '../../common/crud/base-crud.service';
import { createCrudController } from '../../common/crud/crud.controller';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ExportColumn } from '../../common/export/export.service';
import type { AuthenticatedUser } from '../../common/context/request-context';

const shopSchema = z.object({
  code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, - or _'),
  name: z.string().trim().min(2).max(150),
  type: z.enum(['RETAIL', 'WHOLESALE', 'BOTH', 'WAREHOUSE']).default('BOTH'),
  gstin: z.string().trim().length(15).optional().or(z.literal('')),
  phone: z.string().trim().max(15).optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  addressLine1: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  stateCode: z.string().length(2).default('09'),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/, 'PIN code must be 6 digits').optional().or(z.literal('')),
  monthlyRent: z.coerce.number().min(0).optional(),
  areaSqft: z.coerce.number().int().min(0).optional(),
  invoicePrefix: z.string().trim().max(10).default('INV'),
  isActive: z.boolean().default(true),
});

@Injectable()
export class ShopsService extends BaseCrudService<Record<string, unknown>> {
  protected readonly config: CrudResourceConfig = {
    model: 'Shop',
    entityType: 'Shop',
    labelField: 'name',
    // A shop with any history cannot be deleted — its invoices and stock reference it.
    protectedRelations: ['salesInvoices', 'stockItems', 'employees'],
    query: {
      searchFields: ['name', 'code', 'city', 'phone'],
      filterableFields: ['type', 'isActive', 'stateCode', 'city'],
      sortableFields: ['name', 'code', 'createdAt', 'monthlyRent'],
      defaultSort: { field: 'name', direction: 'asc' },
    },
  };

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Users assigned to specific shops see only those. An empty assignment means
   * organization-wide, which is how OWNER and ADMIN work.
   */
  protected override scopeWhere(user: AuthenticatedUser): Record<string, unknown> {
    return {
      organizationId: user.organizationId,
      ...(user.shopIds.length > 0 ? { id: { in: user.shopIds } } : {}),
    };
  }
}

const exportColumns: ExportColumn[] = [
  { key: 'code', header: 'Code', width: 12 },
  { key: 'name', header: 'Shop', width: 28 },
  { key: 'type', header: 'Type', width: 14 },
  { key: 'city', header: 'City', width: 16 },
  { key: 'phone', header: 'Phone', width: 14 },
  { key: 'gstin', header: 'GSTIN', width: 18 },
  { key: 'monthlyRent', header: 'Monthly Rent', format: 'currency' },
  { key: 'areaSqft', header: 'Area (sqft)', format: 'number' },
  { key: 'isActive', header: 'Active', format: 'boolean', width: 9 },
];

const ShopsCrudController = createCrudController<ShopsService>({
  serviceClass: ShopsService,
  path: 'shops',
  tag: 'Shops',
  resource: 'shop',
  entityType: 'Shop',
  labelField: 'name',
  createSchema: shopSchema,
  updateSchema: shopSchema.partial(),
  exportColumns,
});

@Module({
  controllers: [ShopsCrudController],
  providers: [ShopsService],
  exports: [ShopsService],
})
export class ShopsModule {}
