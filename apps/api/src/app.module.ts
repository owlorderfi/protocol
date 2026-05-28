import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { ScheduledOrdersModule } from './scheduled-orders/scheduled-orders.module.js';
import { AdminModule } from './admin/admin.module.js';
import { MonitoringModule } from './monitoring/monitoring.module.js';
import { MarketModule } from './market/market.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        // 5 req/min/IP is enough for a legit user flow (nonce → login = 2
        // requests; allow up to 2 retries if MetaMask sign fails). Bots
        // hitting /auth/nonce in bursts (we observed 10 in 800ms from a
        // chain-scraper probing the keeper wallet) get throttled at the
        // 6th request inside the same minute window.
        ttl: 60_000,
        limit: 5,
      },
    ]),
    PrismaModule,
    HealthModule,
    AuthModule,
    OrdersModule,
    ScheduledOrdersModule,
    AdminModule,
    MonitoringModule,
    MarketModule,
  ],
})
export class AppModule {}
