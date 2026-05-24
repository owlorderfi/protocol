import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../common/prisma/prisma.module.js';
import { AdminController } from './admin.controller.js';
import { OwnerService } from './owner.service.js';
import { OwnerOnlyGuard } from './owner-only.guard.js';
import { ContractStateService } from './contract-state.service.js';
import { AdminStatsService } from './admin-stats.service.js';

/**
 * Admin / operator-only endpoints. Pulls in AuthModule so the
 * Web3JwtAuthGuard (and JwtService + AuthService it depends on) are
 * available to the guard chain. PrismaModule for DB-stats queries.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AdminController],
  providers: [OwnerService, OwnerOnlyGuard, ContractStateService, AdminStatsService],
})
export class AdminModule {}
