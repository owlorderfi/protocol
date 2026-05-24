import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminController } from './admin.controller.js';
import { OwnerService } from './owner.service.js';
import { OwnerOnlyGuard } from './owner-only.guard.js';
import { ContractStateService } from './contract-state.service.js';

/**
 * Admin / operator-only endpoints. Pulls in AuthModule so the
 * Web3JwtAuthGuard (and JwtService + AuthService it depends on) are
 * available to the guard chain.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [OwnerService, OwnerOnlyGuard, ContractStateService],
})
export class AdminModule {}
