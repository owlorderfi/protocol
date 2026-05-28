import { Module } from '@nestjs/common';
import { MarketController } from './market.controller.js';
import { MarketService } from './market.service.js';

@Module({
  controllers: [MarketController],
  providers: [MarketService],
})
export class MarketModule {}
