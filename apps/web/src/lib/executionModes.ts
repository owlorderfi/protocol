/**
 * Execution mode macro-presets for scheduled orders (DCA / TWAP).
 *
 * Most users don't want to think about slippage AND price-floor AND
 * tolerance separately on first use. The mode picker bundles the three
 * risk knobs into a single named choice. Power users click "Custom"
 * to expose the granular controls.
 *
 * Mode semantics (consistent across DCA + TWAP):
 *   - Safe    → tight protection; slower fills (more skips during noise)
 *   - Balanced → mainstream defaults; what 80% of users want
 *   - Turbo   → permissive; fires through volatility, accepts wider fills
 *
 * Picked here (not per-form) so a future "limit order has modes too"
 * extension can reuse the same vocabulary. The actual % values differ
 * by product (DCA tolerates more drift than TWAP because of longer
 * horizons), so we publish per-product preset tables.
 */

export type ExecutionMode = 'safe' | 'balanced' | 'turbo' | 'custom';

export interface ModePreset {
  slippagePct: number;
  /** Max % the on-chain execution rate can drop from the signing-time
   *  quote before the slice gets rejected by the contract's floor check.
   *  Direction-agnostic since the KISS refactor: the % is always
   *  "below current rate", regardless of trade direction. */
  floorTolerancePct: number;
}

export const DCA_MODE_PRESETS: Record<Exclude<ExecutionMode, 'custom'>, ModePreset> = {
  // DCA runs over long horizons; wider floors avoid premature stops
  // on routine volatility.
  safe:     { slippagePct: 0.3, floorTolerancePct: 5 },
  balanced: { slippagePct: 0.5, floorTolerancePct: 25 },
  // Turbo sits at the max preset (50%) — past that the floor is
  // effectively off and the preview line goes blank. Use the "off"
  // preset for true no-floor.
  turbo:    { slippagePct: 2.0, floorTolerancePct: 50 },
};

export const TWAP_MODE_PRESETS: Record<Exclude<ExecutionMode, 'custom'>, ModePreset> = {
  // TWAP runs are short (minutes to hours), so the asset shouldn't move
  // much; tighter floors protect against bad fills mid-window.
  safe:     { slippagePct: 0.3, floorTolerancePct: 3 },
  balanced: { slippagePct: 0.5, floorTolerancePct: 5 },
  turbo:    { slippagePct: 2.0, floorTolerancePct: 20 },
};

// Ladder has only the slippage knob — each rung has its OWN trigger price
// embedded in the order, so there's no per-rung floor tolerance like on
// DCA/TWAP. The mode picker still gives visual parity with the other forms.
export interface LadderModePreset {
  slippagePct: number;
}

export const LADDER_MODE_PRESETS: Record<Exclude<ExecutionMode, 'custom'>, LadderModePreset> = {
  safe:     { slippagePct: 0.3 },
  balanced: { slippagePct: 0.5 },
  turbo:    { slippagePct: 2.0 },
};

export function detectActiveLadderMode(current: LadderModePreset): ExecutionMode {
  for (const m of ['safe', 'balanced', 'turbo'] as const) {
    if (Math.abs(current.slippagePct - LADDER_MODE_PRESETS[m].slippagePct) < 0.001) {
      return m;
    }
  }
  return 'custom';
}

export const MODE_LABELS: Record<Exclude<ExecutionMode, 'custom'>, { emoji: string; name: string; tagline: string }> = {
  safe:     { emoji: '🛡️', name: 'Safe',     tagline: 'Tight protection · slower fills' },
  balanced: { emoji: '⚖️', name: 'Balanced', tagline: 'Mainstream defaults' },
  turbo:    { emoji: '🚀', name: 'Turbo',    tagline: 'Fires through volatility' },
};

/**
 * Detects which mode a current (slippage, floor) tuple matches, or
 * returns 'custom' when the user has diverged from any preset. Used to
 * keep the mode picker honest after manual edits.
 */
export function detectActiveMode(
  current: ModePreset,
  table: Record<Exclude<ExecutionMode, 'custom'>, ModePreset>,
): ExecutionMode {
  for (const m of ['safe', 'balanced', 'turbo'] as const) {
    const p = table[m];
    if (
      Math.abs(current.slippagePct - p.slippagePct) < 0.001 &&
      current.floorTolerancePct === p.floorTolerancePct
    ) {
      return m;
    }
  }
  return 'custom';
}
