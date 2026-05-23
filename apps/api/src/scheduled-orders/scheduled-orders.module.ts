import { Module } from '@nestjs/common';
import { ScheduledOrdersController } from './scheduled-orders.controller.js';
import { ScheduledOrdersService } from './scheduled-orders.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule], // Web3JwtAuthGuard needs JwtService + AuthService
  controllers: [ScheduledOrdersController],
  providers: [ScheduledOrdersService],
  exports: [ScheduledOrdersService],
})
export class ScheduledOrdersModule {}
