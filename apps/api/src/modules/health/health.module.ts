import { Controller, Get } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public, SkipAudit } from '../../common/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';

@ApiTags('Health')
@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  @SkipAudit()
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness probe. Kubernetes uses this to decide whether to route traffic here, so
   * it must actually touch the database rather than just returning 200.
   */
  @Get('ready')
  @Public()
  @SkipAudit()
  @ApiOperation({ summary: 'Readiness probe — verifies the database is reachable' })
  async ready() {
    const startedAt = Date.now();
    await this.prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ok',
      database: { status: 'up', latencyMs: Date.now() - startedAt },
      timestamp: new Date().toISOString(),
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
