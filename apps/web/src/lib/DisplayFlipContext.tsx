import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Per-pair display-flip state. Lets the form's ⇄ button keep the
 * OrdersList in sync — clicking "show prices in the other direction"
 * on a Ladder/DCA/TWAP form flips the displayed direction in the
 * orders table for the same pair.
 *
 * Pair direction is order-insensitive: USDC/WETH and WETH/USDC share
 * the same flip state. Stored in-memory only (no localStorage) — flip
 * is a transient view preference, not something to persist across
 * sessions. Default = unflipped (canonical = tokenOut/tokenIn).
 */

type FlipValue = boolean | ((prev: boolean) => boolean);
type FlipSetter = (next: FlipValue) => void;

interface DisplayFlipState {
  get: (chainId: number, tokenA: string, tokenB: string) => boolean;
  set: (chainId: number, tokenA: string, tokenB: string, value: FlipValue) => void;
}

const DisplayFlipContext = createContext<DisplayFlipState | null>(null);

function pairKey(chainId: number, tokenA: string, tokenB: string): string {
  const [x, y] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  return `${chainId}:${x}:${y}`;
}

export function DisplayFlipProvider({ children }: { children: ReactNode }) {
  const [flips, setFlips] = useState<Map<string, boolean>>(new Map());

  const value: DisplayFlipState = {
    get: (chainId, a, b) => flips.get(pairKey(chainId, a, b)) ?? false,
    set: (chainId, a, b, next) => {
      const key = pairKey(chainId, a, b);
      setFlips((prev) => {
        const cur = prev.get(key) ?? false;
        const newVal = typeof next === 'function' ? next(cur) : next;
        if (newVal === cur) return prev;
        const map = new Map(prev);
        map.set(key, newVal);
        return map;
      });
    },
  };

  return (
    <DisplayFlipContext.Provider value={value}>{children}</DisplayFlipContext.Provider>
  );
}

/**
 * Returns [flipped, setFlipped] for a token pair on a chain. Setter
 * supports both `setFlipped(true)` and `setFlipped((v) => !v)` for
 * compatibility with forms that already use the functional form.
 */
export function useDisplayFlip(
  chainId: number,
  tokenA: string,
  tokenB: string,
): [boolean, FlipSetter] {
  const ctx = useContext(DisplayFlipContext);
  if (!ctx) throw new Error('useDisplayFlip used outside <DisplayFlipProvider>');
  const flipped = ctx.get(chainId, tokenA, tokenB);
  const setFlipped: FlipSetter = (next) => ctx.set(chainId, tokenA, tokenB, next);
  return [flipped, setFlipped];
}
