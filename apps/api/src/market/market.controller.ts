import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { getAddress, type Address } from 'viem';
import { isSupportedChainId, type OrderType } from '@owlorderfi/shared';
import { CfThrottlerGuard } from '../common/guards/cf-throttler.guard.js';
import { MarketService, EMPTY_TWAP, type TwapResult } from './market.service.js';
import { PrismaService } from '../common/prisma/prisma.service.js';

const ORDER_TYPES = new Set(['LIMIT_BUY', 'LIMIT_SELL', 'STOP_LOSS', 'TAKE_PROFIT']);

interface MarketParams {
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  orderType: OrderType;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}

/**
 * Public market-data endpoint. Quotes are public information and the
 * frontend needs them before sign-in, so this is intentionally unguarded
 * — abuse is bounded by the global throttler + the service's server-side
 * cache (popular pairs cost ~one RPC call per window regardless of how
 * many callers ask).
 */
@Controller('market')
export class MarketController {
  constructor(
    private readonly market: MarketService,
    private readonly prisma: PrismaService,
  ) {}

  // Generous per-IP cap: legit polling is ~6 req/min per watched pair, so
  // 60/min covers ~10 pairs with headroom while capping abuse. Spot is
  // amount-independent + cached per (pair, orderType), so popular pairs
  // cost ~one RPC round per window regardless of caller count.
  @Get('quote')
  @UseGuards(CfThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async quote(
    @Query('chainId') chainIdRaw?: string,
    @Query('tokenIn') tokenInRaw?: string,
    @Query('tokenOut') tokenOutRaw?: string,
    @Query('orderType') orderTypeRaw?: string,
    @Query('tokenInDecimals') tokenInDecRaw?: string,
    @Query('tokenOutDecimals') tokenOutDecRaw?: string,
  ): Promise<{ priceScaled: string | null }> {
    const params = this.parseParams(
      chainIdRaw, tokenInRaw, tokenOutRaw, orderTypeRaw, tokenInDecRaw, tokenOutDecRaw,
    );
    try {
      return await this.market.getQuote(params);
    } catch {
      // No pool / no liquidity / RPC blip → no price right now. Not a
      // client error — return null so the UI just shows "no rate yet".
      return { priceScaled: null };
    }
  }

  // TWAP volatility/trend for the order forms' smart-suggest. Same shape +
  // throttle + cache rationale as /quote; reads the pool's observe() buffer
  // server-side. No pool / RPC blip → empty result (UI hides the hint).
  @Get('twap')
  @UseGuards(CfThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async twap(
    @Query('chainId') chainIdRaw?: string,
    @Query('tokenIn') tokenInRaw?: string,
    @Query('tokenOut') tokenOutRaw?: string,
    @Query('orderType') orderTypeRaw?: string,
    @Query('tokenInDecimals') tokenInDecRaw?: string,
    @Query('tokenOutDecimals') tokenOutDecRaw?: string,
  ): Promise<TwapResult> {
    const params = this.parseParams(
      chainIdRaw, tokenInRaw, tokenOutRaw, orderTypeRaw, tokenInDecRaw, tokenOutDecRaw,
    );
    try {
      return await this.market.getTwap(params);
    } catch {
      return EMPTY_TWAP;
    }
  }

  // Longer-horizon trend signal, derived from MarketSnapshotService's
  // every-5-min PoolSpotSnapshot rows. Smart Suggest's 1h-horizon Wait
  // pill consumes this; 30s / 5m pills keep using /twap (observe-based,
  // live). Match-window math: the trend is calculated over exactly the
  // requested horizon (no extrapolation), so the caller picks the
  // horizon that matches its drift-projection target.
  //
  // Response shape:
  //   { trendPct, sampleCount, oldestTs, latestTs, available }
  // `available=false` when there aren't enough snapshots yet (we haven't
  // accumulated `horizonSec` of history); UI falls back to the 5m trend
  // and clamps drift to 0 beyond that.
  @Get('trend')
  @UseGuards(CfThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async trend(
    @Query('chainId') chainIdRaw?: string,
    @Query('tokenIn') tokenInRaw?: string,
    @Query('tokenOut') tokenOutRaw?: string,
    @Query('horizonSec') horizonSecRaw?: string,
  ): Promise<{
    trendPct: number | null;
    sampleCount: number;
    oldestTs: string | null;
    latestTs: string | null;
    available: boolean;
  }> {
    const chainId = Number.parseInt(chainIdRaw ?? '', 10);
    if (!Number.isFinite(chainId) || !isSupportedChainId(chainId)) {
      throw new BadRequestException(`Unsupported chainId: ${chainIdRaw}`);
    }
    let tokenIn: Address;
    let tokenOut: Address;
    try {
      tokenIn = getAddress(tokenInRaw ?? '');
      tokenOut = getAddress(tokenOutRaw ?? '');
    } catch {
      throw new BadRequestException('tokenIn/tokenOut must be valid addresses');
    }
    const horizonSec = Number.parseInt(horizonSecRaw ?? '', 10);
    // 5min lower bound matches the snapshot interval (anything smaller and
    // we'd often hit zero samples in the window); 24h upper bound matches
    // the retention's usable window. Smart Suggest only asks for 3600 (1h)
    // today; the broader range leaves room for a future UI trend ribbon.
    if (!Number.isFinite(horizonSec) || horizonSec < 300 || horizonSec > 86400) {
      throw new BadRequestException('horizonSec must be between 300 and 86400');
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - horizonSec * 1000);
    // Latest snapshot + earliest-in-window via the descending-ts compound
    // index. Two queries beat a window aggregate because both are
    // single-row lookups.
    const [latest, earliest] = await Promise.all([
      this.prisma.poolSpotSnapshot.findFirst({
        where: {
          chainId,
          tokenIn: tokenIn.toLowerCase(),
          tokenOut: tokenOut.toLowerCase(),
        },
        orderBy: { ts: 'desc' },
        select: { priceScaled: true, ts: true },
      }),
      this.prisma.poolSpotSnapshot.findFirst({
        where: {
          chainId,
          tokenIn: tokenIn.toLowerCase(),
          tokenOut: tokenOut.toLowerCase(),
          ts: { gte: cutoff },
        },
        orderBy: { ts: 'asc' },
        select: { priceScaled: true, ts: true },
      }),
    ]);

    // No latest = pair not snapshotted (yet). UI falls back to 5m TWAP.
    if (!latest || !earliest) {
      return { trendPct: null, sampleCount: 0, oldestTs: null, latestTs: null, available: false };
    }
    // earliest must be at least older than (horizonSec - one snapshot
    // interval). If the table has < horizon-1step of history, the result
    // is biased (effective window shorter than requested), so we surface
    // `available=false` and let the UI decide what to do.
    const effectiveWindowSec = (latest.ts.getTime() - earliest.ts.getTime()) / 1000;
    if (effectiveWindowSec < horizonSec - 600) {
      return {
        trendPct: null,
        sampleCount: 0,
        oldestTs: earliest.ts.toISOString(),
        latestTs: latest.ts.toISOString(),
        available: false,
      };
    }

    // Number conversion: priceScaled is bigint-as-string ×1e18. Both sides
    // share the same scale so the ratio is dimensionless; converting via
    // Number loses ~16 digits of precision at most, well below the noise
    // floor of a trend percentage.
    const latestNum = Number(latest.priceScaled) / 1e18;
    const earliestNum = Number(earliest.priceScaled) / 1e18;
    if (!Number.isFinite(latestNum) || !Number.isFinite(earliestNum) || earliestNum <= 0) {
      return {
        trendPct: null,
        sampleCount: 0,
        oldestTs: earliest.ts.toISOString(),
        latestTs: latest.ts.toISOString(),
        available: false,
      };
    }
    const trendPct = ((latestNum - earliestNum) / earliestNum) * 100;

    // Sample count is a rough usefulness signal — at 5-min intervals over
    // a 1h horizon we expect ~12 samples; under 4 the trend is dominated
    // by single-sample noise.
    const sampleCount = await this.prisma.poolSpotSnapshot.count({
      where: {
        chainId,
        tokenIn: tokenIn.toLowerCase(),
        tokenOut: tokenOut.toLowerCase(),
        ts: { gte: cutoff },
      },
    });

    return {
      trendPct,
      sampleCount,
      oldestTs: earliest.ts.toISOString(),
      latestTs: latest.ts.toISOString(),
      available: true,
    };
  }

  // Shared validation for the public market endpoints. Throws 400 on bad
  // input; returns the normalized, typed params on success.
  private parseParams(
    chainIdRaw?: string,
    tokenInRaw?: string,
    tokenOutRaw?: string,
    orderTypeRaw?: string,
    tokenInDecRaw?: string,
    tokenOutDecRaw?: string,
  ): MarketParams {
    const chainId = Number.parseInt(chainIdRaw ?? '', 10);
    if (!Number.isFinite(chainId) || !isSupportedChainId(chainId)) {
      throw new BadRequestException(`Unsupported chainId: ${chainIdRaw}`);
    }
    let tokenIn: Address;
    let tokenOut: Address;
    try {
      tokenIn = getAddress(tokenInRaw ?? '');
      tokenOut = getAddress(tokenOutRaw ?? '');
    } catch {
      throw new BadRequestException('tokenIn/tokenOut must be valid addresses');
    }
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
      throw new BadRequestException('tokenIn and tokenOut must differ');
    }
    if (!orderTypeRaw || !ORDER_TYPES.has(orderTypeRaw)) {
      throw new BadRequestException(`Invalid orderType: ${orderTypeRaw}`);
    }
    const tokenInDecimals = Number.parseInt(tokenInDecRaw ?? '', 10);
    const tokenOutDecimals = Number.parseInt(tokenOutDecRaw ?? '', 10);
    if (
      !Number.isInteger(tokenInDecimals) || tokenInDecimals < 0 || tokenInDecimals > 30 ||
      !Number.isInteger(tokenOutDecimals) || tokenOutDecimals < 0 || tokenOutDecimals > 30
    ) {
      throw new BadRequestException('tokenInDecimals/tokenOutDecimals out of range');
    }
    return {
      chainId,
      tokenIn,
      tokenOut,
      orderType: orderTypeRaw as OrderType,
      tokenInDecimals,
      tokenOutDecimals,
    };
  }
}
