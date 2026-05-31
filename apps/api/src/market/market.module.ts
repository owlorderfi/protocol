import { Module } from '@nestjs/common';
import { MarketController } from './market.controller.js';
import { MarketService } from './market.service.js';
import { MarketSnapshotService } from './market-snapshot.service.js';

@Module({
  controllers: [MarketController],
  providers: [MarketService, MarketSnapshotService],
})
export class MarketModule {}
