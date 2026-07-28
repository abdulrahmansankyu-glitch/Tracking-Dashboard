import { Module } from '@nestjs/common';

import { ProductsController, ProductsCrudController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  // Specific routes first: Nest matches in registration order.
  controllers: [ProductsController, ProductsCrudController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
