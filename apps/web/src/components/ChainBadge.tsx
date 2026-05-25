/**
 * Compact chain marker — 2-3 letter abbreviation in a colored pill,
 * with the full chain name surfacing on hover via the native `title`
 * tooltip. Lives next to order pair labels when the user is in
 * "show all chains" mode so a glance distinguishes a Base-Sepolia row
 * from an Optimism-Sepolia one without reading deeper into the row.
 *
 * Colors are picked per chain (not generated) so the same chain stays
 * the same color across the UI — visual consistency reduces the chance
 * of mis-reading a row. Unknown chains fall back to neutral slate.
 */

import { CHAINS, type ChainIdType } from '@owlorderfi/shared';

interface Props {
  chainId: number;
  /** Slightly more vertical padding on row contexts vs inline-label use. */
  size?: 'sm' | 'md';
}

// Per-chain palette. Keeps adjacent chains visually distinct without
// reaching for an icon font. New chains: add an entry here.
const CHAIN_STYLES: Record<number, { abbr: string; cls: string }> = {
  137:      { abbr: 'POL',  cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  8453:     { abbr: 'BASE', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  84532:    { abbr: 'BASE', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  421614:   { abbr: 'ARB',  cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  11155420: { abbr: 'OP',   cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  80002:    { abbr: 'AMOY', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  31337:    { abbr: 'ANV',  cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
};

export function ChainBadge({ chainId, size = 'sm' }: Props) {
  const info = CHAINS[chainId as ChainIdType];
  const fallback = { abbr: String(chainId).slice(0, 4), cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' };
  const style = CHAIN_STYLES[chainId] ?? fallback;
  const fullName = info?.name ?? `Chain ${chainId}`;
  const pad = size === 'md' ? 'px-2 py-0.5' : 'px-1.5 py-0';
  return (
    <span
      title={`${fullName} (chain ${chainId})`}
      className={`inline-flex items-center rounded border ${pad} font-mono text-xs ${style.cls}`}
    >
      {style.abbr}
    </span>
  );
}
