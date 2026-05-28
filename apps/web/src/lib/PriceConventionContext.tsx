import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { PriceConvention } from './priceFloor';

/**
 * App-wide price display convention (see priceFloor.PriceConvention):
 *   - 'swap'   → "1 tokenIn = X tokenOut", follows the trade direction
 *   - 'market' → numéraire hierarchy, "1 WETH = X USDC" regardless of side
 *
 * Persisted to localStorage so the user's choice survives reloads. This
 * is a deliberate, sticky preference (unlike the transient per-pair ⇄
 * flip in DisplayFlipContext, which is in-memory only).
 */

const STORAGE_KEY = 'polyorder.priceConvention';

interface ContextValue {
  convention: PriceConvention;
  setConvention: (c: PriceConvention) => void;
}

const PriceConventionContext = createContext<ContextValue | null>(null);

function readInitial(): PriceConvention {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'swap' || v === 'market') return v;
  } catch {
    /* localStorage unavailable (SSR / privacy mode) — fall through */
  }
  // Default to 'market': matches what traders see on Binance/Coinbase
  // and keeps a pair's direction stable regardless of swap side.
  return 'market';
}

export function PriceConventionProvider({ children }: { children: ReactNode }) {
  const [convention, setConventionState] = useState<PriceConvention>(readInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, convention);
    } catch {
      /* ignore persistence failure */
    }
  }, [convention]);

  return (
    <PriceConventionContext.Provider
      value={{ convention, setConvention: setConventionState }}
    >
      {children}
    </PriceConventionContext.Provider>
  );
}

export function usePriceConvention(): ContextValue {
  const ctx = useContext(PriceConventionContext);
  if (!ctx) throw new Error('usePriceConvention used outside <PriceConventionProvider>');
  return ctx;
}
