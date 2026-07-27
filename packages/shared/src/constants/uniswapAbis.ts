/**
 * Minimal Uniswap V3 read ABIs shared across the keeper (spot trigger),
 * the API (display quote), and the web (TWAP smart-suggest). These three
 * previously each carried hand-copied copies of the same fragments; one
 * source here keeps the on-chain shapes from drifting.
 *
 * `as const` is load-bearing: viem infers `readContract` return types from
 * the literal ABI, so these must stay readonly tuples (the compiled `.d.ts`
 * preserves that).
 */
export const UNISWAP_V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const UNISWAP_V3_POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    // Needed to tell a real average from an extrapolated one: when no
    // observation was written inside the requested window, `observe` returns
    // the current tick at both ends and the "TWAP" equals spot.
    type: 'function',
    name: 'observations',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [
      { name: 'blockTimestamp', type: 'uint32' },
      { name: 'tickCumulative', type: 'int56' },
      { name: 'secondsPerLiquidityCumulativeX128', type: 'uint160' },
      { name: 'initialized', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [{ name: 'secondsAgos', type: 'uint32[]' }],
    outputs: [
      { name: 'tickCumulatives', type: 'int56[]' },
      { name: 'secondsPerLiquidityCumulativeX128s', type: 'uint160[]' },
    ],
  },
] as const;
