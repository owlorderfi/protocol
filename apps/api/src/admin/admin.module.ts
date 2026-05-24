import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminController } from './admin.controller.js';
import { OwnerService } from './owner.service.js';
import { OwnerOnlyGuard } from './owner-only.guard.js';

/**
 * Admin / operator-only endpoints. Pulls in AuthModule so the
 * Web3JwtAuthGuard (and JwtService + AuthService it depends on) are
 * available to the guard chain.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [OwnerService, OwnerOnlyGuard],
})
export class AdminModule {}
