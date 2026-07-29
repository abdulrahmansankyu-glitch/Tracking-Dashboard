import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import configuration from './config/configuration';
import { CommonModule } from './common/common.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { ShopScopeGuard } from './common/guards/shop-scope.guard';
import { AuthModule } from './modules/auth/auth.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CustomersModule } from './modules/customers/customers.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ProductsModule } from './modules/products/products.module';
import { SalesModule } from './modules/sales/sales.module';
import { ShopsModule } from './modules/shops/shops.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';

/**
 * Application root.
 *
 * The three guards are registered globally and run in order: authenticate, then check
 * the permission, then check the shop scope. Registering them here rather than
 * decorating each controller means a new endpoint is secure by default — a developer
 * has to opt out with `@Public()`, which is visible in review, instead of forgetting to
 * opt in, which is not.
 *
 * Domain modules are added to `imports` as they are built.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      cache: true,
      envFilePath: ['.env', '../../.env'],
    }),

    // Blunt protection against credential stuffing and runaway scripts. Per-route
    // overrides tighten this further on login and export endpoints.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),

    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.accessSecret'),
        signOptions: { expiresIn: config.get<string>('jwt.accessTtl') ?? '15m' },
      }),
    }),

    ScheduleModule.forRoot(),

    PrismaModule,
    CommonModule,
    HealthModule,
    AuthModule,
    CategoriesModule,
    ShopsModule,
    SuppliersModule,
    ProductsModule,
    CustomersModule,
    InventoryModule,
    SalesModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: ShopScopeGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
