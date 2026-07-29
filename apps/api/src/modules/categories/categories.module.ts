import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';

import { BaseCrudService, type CrudResourceConfig } from '../../common/crud/base-crud.service';
import { createCrudController } from '../../common/crud/crud.controller';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ExportColumn } from '../../common/export/export.service';
import type { AuthenticatedUser } from '../../common/context/request-context';

/**
 * Product categories — a simple two-level tree (Sarees → Banarasi Saree).
 *
 * Kept deliberately small: this exists so products can be filed and the product form
 * has something to pick from, not as a taxonomy system.
 */
const categorySchema = z.object({
  name: z.string().trim().min(2, 'Category name is required').max(100),
  parentId: z.string().optional(),
  description: z.string().max(500).optional(),
  defaultHsnCode: z.string().regex(/^\d{4}(\d{2})?(\d{2})?$/, 'HSN must be 4, 6 or 8 digits').optional().or(z.literal('')),
  defaultGstRate: z.coerce.number().min(0).max(28).optional(),
  displayOrder: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

@Injectable()
export class CategoriesService extends BaseCrudService<Record<string, unknown>> {
  protected readonly config: CrudResourceConfig = {
    model: 'Category',
    entityType: 'Category',
    labelField: 'name',
    // A category holding products cannot be deleted — the products would be orphaned.
    protectedRelations: ['products'],
    listInclude: { parent: { select: { id: true, name: true } } },
    query: {
      searchFields: ['name', 'slug'],
      filterableFields: ['parentId', 'isActive', 'defaultGstRate'],
      sortableFields: ['name', 'displayOrder', 'createdAt'],
      defaultSort: { field: 'name', direction: 'asc' },
    },
  };

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected override scopeWhere(user: AuthenticatedUser): Record<string, unknown> {
    return { organizationId: user.organizationId };
  }

  override async create(
    user: AuthenticatedUser,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // The slug is derived, never typed — it only has to be stable and unique.
    const base = String(data.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let slug = base;
    let attempt = 1;
    while (
      await this.prisma.category.findUnique({
        where: { organizationId_slug: { organizationId: user.organizationId, slug } },
      })
    ) {
      attempt += 1;
      slug = `${base}-${attempt}`;
    }
    return super.create(user, { ...data, slug });
  }
}

const exportColumns: ExportColumn[] = [
  { key: 'name', header: 'Category', width: 28 },
  { key: 'parent.name', header: 'Parent', width: 24 },
  { key: 'defaultHsnCode', header: 'Default HSN', width: 14 },
  { key: 'defaultGstRate', header: 'Default GST %', format: 'percent' },
  { key: 'isActive', header: 'Active', format: 'boolean', width: 9 },
];

const CategoriesCrudController = createCrudController<CategoriesService>({
  serviceClass: CategoriesService,
  path: 'categories',
  tag: 'Categories',
  resource: 'category',
  entityType: 'Category',
  labelField: 'name',
  createSchema: categorySchema,
  updateSchema: categorySchema.partial(),
  exportColumns,
});

@Module({
  controllers: [CategoriesCrudController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
