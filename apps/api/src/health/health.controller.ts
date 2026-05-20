import { Controller, Get, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service.js';

interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: Record<string, 'ok' | 'error'>;
  timestamp: string;
}

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const checks: Record<string, 'ok' | 'error'> = {
      api: 'ok',
      database: 'ok',
    };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      this.logger.warn('DB health check failed', err);
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
