import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PAYMENT_MODES } from '@intoto/shared';
import { z } from 'zod';

import { CurrentUser, RequirePermissions, SkipAudit } from '../../common/decorators';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { AuthenticatedUser } from '../../common/context/request-context';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesService } from './sales.service';

const createSaleSchema = z.object({
  shopId: z.string().min(1, 'Select a shop'),
  customerId: z.string().optional(),
  walkInName: z.string().max(150).optional(),
  walkInPhone: z.string().max(15).optional(),
  isWholesale: z.boolean().optional(),
  invoiceDate: z.string().datetime().optional(),
  notes: z.string().max(1000).optional(),
  invoiceDiscount: z.coerce.number().min(0).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        variantId: z.string().optional(),
        quantity: z.coerce.number().positive('Quantity must be greater than zero'),
        unitPrice: z.coerce.number().min(0).optional(),
        discountPercent: z.coerce.number().min(0).max(100).optional(),
        discountAmount: z.coerce.number().min(0).optional(),
      }),
    )
    .min(1, 'Add at least one item to the bill'),
  payments: z
    .array(
      z.object({
        mode: z.enum(PAYMENT_MODES),
        amount: z.coerce.number().min(0),
        reference: z.string().max(100).optional(),
      }),
    )
    .optional(),
});

const voidSchema = z.object({
  reason: z.string().trim().min(3, 'Explain why this bill is being cancelled').max(500),
});

@ApiTags('Sales')
@ApiBearerAuth()
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get('summary')
  @RequirePermissions('sale:read')
  @SkipAudit()
  @ApiOperation({ summary: "Today's and this month's sales, profit and payment mix" })
  @ApiQuery({ name: 'shopId', required: false })
  @ApiQuery({ name: 'date', required: false })
  summary(
    @Query('shopId') shopId: string | undefined,
    @Query('date') date: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sales.summary(user, { shopId, date });
  }

  @Get()
  @RequirePermissions('sale:read')
  @SkipAudit()
  @ApiOperation({ summary: 'List invoices' })
  list(
    @Query('shopId') shopId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sales.list(user, {
      shopId, search, dateFrom, dateTo,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('sale:read')
  @SkipAudit()
  @ApiOperation({ summary: 'One invoice with lines and payments' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.findOne(user, id);
  }

  @Post()
  @RequirePermissions('sale:create')
  @ApiOperation({
    summary: 'Create a GST invoice — computes tax, deducts stock and records profit atomically',
  })
  create(
    @Body(zodBody(createSaleSchema)) body: z.infer<typeof createSaleSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sales.createInvoice(user, body);
  }

  @Post(':id/void')
  @RequirePermissions('sale:void')
  @ApiOperation({ summary: 'Cancel an invoice and return the stock. The number is never reused.' })
  voidInvoice(
    @Param('id') id: string,
    @Body(zodBody(voidSchema)) body: z.infer<typeof voidSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sales.voidInvoice(user, id, body.reason);
  }
}

@Module({
  imports: [InventoryModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
