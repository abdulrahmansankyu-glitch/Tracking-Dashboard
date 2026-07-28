import { Module } from '@nestjs/common';

import { CustomersController, CustomersCrudController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  // Specific routes first: Nest matches in registration order.
  controllers: [CustomersController, CustomersCrudController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
