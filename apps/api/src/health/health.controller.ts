import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    const checks: Record<string, 'ok' | 'error'> = {
      api: 'ok',
      database: 'ok',
    };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      checks.database = 'error';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return {
      status: allOk ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
