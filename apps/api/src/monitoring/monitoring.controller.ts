import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { OwnerOnlyGuard } from '../admin/owner-only.guard.js';
import { MonitoringService, type MonitoringSnapshot } from './monitoring.service.js';
import { UsersStatsService, type UsersStats } from './services/users-stats.service.js';

/**
 * Operator-only monitoring endpoints — surfaces real-time traffic
 * patterns from the Caddy access log + (later) UFW / fail2ban / SSH /
 * connection summaries. Same gating as the existing admin dashboard:
 * JWT + on-chain owner check via OwnerOnlyGuard. `?chainId=N` query
 * param is required by the guard (per-chain owner read).
 *
 * Routes:
 *   GET /api/admin/monitoring/snapshot?chainId=N
 *     Live collect (~300 ms). Returns the current view. No DB write.
 *     Future B-Bundle 2: add /history that queries MonitoringSnapshot
 *     rows persisted by the scheduler.
 */
@Controller('admin/monitoring')
export class MonitoringController {
  private readonly logger = new Logger(MonitoringController.name);

  constructor(
    private readonly monitoring: MonitoringService,
    private readonly usersStats: UsersStatsService,
  ) {}

  @Get('snapshot')
  @UseGuards(OwnerOnlyGuard)
  async snapshot(): Promise<MonitoringSnapshot> {
    return this.monitoring.collect();
  }

  // Wallet / session aggregate stats (cross-chain). chainId param still
  // required by OwnerOnlyGuard for the per-chain auth check, but the
  // query itself is unfiltered by chain — Users and Sessions are
  // chain-agnostic in the schema.
  @Get('users')
  @UseGuards(OwnerOnlyGuard)
  async users(): Promise<UsersStats> {
    return this.usersStats.collect();
  }
}
