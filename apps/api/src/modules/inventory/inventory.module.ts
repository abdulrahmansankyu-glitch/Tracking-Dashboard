import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { CurrentUser, RequirePermissions, SkipAudit } from '../../common/decorators';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { AuthenticatedUser } from '../../common/context/request-context';
import { InventoryService } from './inventory.service';

const stockInSchema = z.object({
  shopId: z.string().min(1),
  supplierId: z.string().optional(),
  reference: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        variantId: z.string().optional(),
        quantity: z.coerce.number().positive('Quantity must be greater than zero'),
        unitCost: z.coerce.number().min(0),
      }),
    )
    .min(1, 'Add at least one item'),
});

const adjustSchema = z.object({
  shopId: z.string().min(1),
  reason: z.enum(['DAMAGED', 'LOST', 'THEFT', 'EXPIRED', 'COUNT_CORRECTION', 'SAMPLE', 'GIFT', 'OTHER']),
  notes: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        variantId: z.string().optional(),
        quantityDelta: z.coerce.number().refine((n) => n !== 0, 'Adjustment cannot be zero'),
        notes: z.string().max(300).optional(),
      }),
    )
    .min(1, 'Add at least one item'),
});

const transferSchema = z
  .object({
    fromShopId: z.string().min(1),
    toShopId: z.string().min(1),
    notes: z.string().max(500).optional(),
    lines: z
      .array(
        z.object({
          productId: z.string().min(1),
          variantId: z.string().optional(),
          quantity: z.coerce.number().positive(),
        }),
      )
      .min(1, 'Add at least one item'),
  })
  .refine((v) => v.fromShopId !== v.toShopId, {
    message: 'Source and destination shops must be different',
    path: ['toShopId'],
  });

@ApiTags('Inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('stock')
  @RequirePermissions('inventory:read')
  @SkipAudit()
  @ApiOperation({ summary: 'Current stock by shop' })
  @ApiQuery({ name: 'shopId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'lowOnly', required: false })
  stock(
    @Query('shopId') shopId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('lowOnly') lowOnly: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.list(user, {
      shopId,
      search,
      lowOnly: lowOnly === 'true',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('movements')
  @RequirePermissions('inventory:read')
  @SkipAudit()
  @ApiOperation({ summary: 'Movement history — where every unit came from and went' })
  movements(
    @Query('productId') productId: string | undefined,
    @Query('shopId') shopId: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.movements(user, {
      productId,
      shopId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('valuation')
  @RequirePermissions('inventory:read')
  @SkipAudit()
  @ApiOperation({ summary: 'Total stock value per shop' })
  valuation(@CurrentUser() user: AuthenticatedUser) {
    return this.inventory.valuation(user);
  }

  @Post('stock-in')
  @RequirePermissions('inventory:create')
  @ApiOperation({ summary: 'Receive stock into a shop' })
  stockIn(
    @Body(zodBody(stockInSchema)) body: z.infer<typeof stockInSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.stockIn(user, body);
  }

  @Post('adjust')
  @RequirePermissions('stock_adjustment:create')
  @ApiOperation({ summary: 'Write stock off or on — damage, loss, or a miscount' })
  adjust(
    @Body(zodBody(adjustSchema)) body: z.infer<typeof adjustSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.adjust(user, body);
  }

  @Post('transfer')
  @RequirePermissions('stock_transfer:create')
  @ApiOperation({ summary: 'Move stock between shops' })
  transfer(
    @Body(zodBody(transferSchema)) body: z.infer<typeof transferSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.transfer(user, body);
  }
}

@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
