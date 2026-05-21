import { useEffect, useState } from 'react';
import type { OrderType } from '@polyorder/shared';
import { useMarketPrice } from './useMarketPrice';

const MAX_SAMPLES = 6; // ~60s at the 10s refresh of useMarketPrice

export interface PriceHistory {
  current: bigint | null;
  min: bigint | null;
  max: bigint | null;
  /** Number of samples used (max MAX_SAMPLES). 0 means no history yet. */
  samples: number;
}

/**
 * Wraps `useMarketPrice` and tracks the last ~60s of spot samples so the
 * "Suggest target" feature can pick a price level recent enough to be
 * realistic. History resets when the pair (or order type) changes.
 */
export function usePriceHistory(
  orderType: OrderType,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
): PriceHistory {
  const market = useMarketPrice(orderType, tokenIn, tokenOut);
  const [history, setHistory] = useState<bigint[]>([]);

  // Reset on pair / order-type change
  useEffect(() => {
    setHistory([]);
  }, [orderType, tokenIn, tokenOut]);

  // Append new samples (but only when the value actually changes — avoid
  // duplicates from React Query background revalidations returning the
  // same number from cache).
  useEffect(() => {
    if (market.priceScaled === null) return;
    setHistory((prev) => {
      const last = prev[prev.length - 1];
      if (last !== undefined && last === market.priceScaled) return prev;
      const next = [...prev, market.priceScaled!];
      while (next.length > MAX_SAMPLES) next.shift();
      return next;
    });
  }, [market.priceScaled]);

  if (history.length === 0) {
    return { current: market.priceScaled, min: null, max: null, samples: 0 };
  }

  let min = history[0];
  let max = history[0];
  for (const p of history) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return { current: market.priceScaled, min, max, samples: history.length };
}
