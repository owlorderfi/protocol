import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../common/prisma/prisma.module.js';
import { MonitoringController } from './monitoring.controller.js';
import { MonitoringService } from './monitoring.service.js';
import { CaddyCollector } from './collectors/caddy.collector.js';
import { UsersStatsService } from './services/users-stats.service.js';

/**
 * Monitoring panel — surfaces traffic + security signals to the
 * operator via the admin dashboard. Imports:
 *   - AdminModule → re-uses the existing OwnerOnlyGuard (and the
 *     OwnerService it depends on) for per-chain operator-only access.
 *   - AuthModule → guard chain transitively needs Web3JwtAuthGuard.
 *   - PrismaModule → for future B-Bundle 2 persistence of MonitoringSnapshot.
 *
 * See docs/pre-mainnet-hardening-plan.md § B for scope + sequencing.
 */
@Module({
  imports: [AdminModule, AuthModule, PrismaModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, CaddyCollector, UsersStatsService],
})
export class MonitoringModule {}
