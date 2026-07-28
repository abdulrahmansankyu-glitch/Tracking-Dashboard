import { Module } from '@nestjs/common';

import { SuppliersController, SuppliersCrudController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

@Module({
  // Specific routes first: Nest matches in registration order, so `:id/performance`
  // must be declared before the generic `:id`.
  controllers: [SuppliersController, SuppliersCrudController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
