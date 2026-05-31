/**
 * Tiny ERC-20 readers shared by the keeper executors.
 *
 * Both the limit and scheduled executors need to look up token symbols
 * (for the breakeven / dust-filter math) and decimals (for human-readable
 * amount conversions). Centralising the cached readers here keeps the
 * executor files focused on order flow.
 */

import { type Address } from 'viem';
import { createClients } from './chain';

const ERC20_SYMBOL_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

const SYMBOL_CACHE: Record<string, string> = {};

/**
 * Read an ERC-20's `symbol()`, cached per (chainId, address). Falls back
 * to the address prefix when the token doesn't expose a parseable string
 * symbol (rare — legacy bytes32 tokens), so callers can still proceed
 * with a "we couldn't price this" signal rather than crashing.
 */
export async function getErc20Symbol(address: Address): Promise<string> {
  const { publicClient } = createClients();
  const chainId = publicClient.chain?.id ?? 0;
  const key = `${chainId}:${address.toLowerCase()}`;
  if (key in SYMBOL_CACHE) return SYMBOL_CACHE[key]!;
  try {
    const symbol = await publicClient.readContract({
      address,
      abi: ERC20_SYMBOL_ABI,
      functionName: 'symbol',
    });
    SYMBOL_CACHE[key] = symbol;
    return symbol;
  } catch {
    SYMBOL_CACHE[key] = address.slice(0, 6);
    return SYMBOL_CACHE[key]!;
  }
}
