import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { getAddress, type Address } from 'viem';
import { isSupportedChainId, type OrderType } from '@owlorderfi/shared';
import { CfThrottlerGuard } from '../common/guards/cf-throttler.guard.js';
import { MarketService, EMPTY_TWAP, type TwapResult } from './market.service.js';

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
  constructor(private readonly market: MarketService) {}

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
