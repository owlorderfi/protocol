/**
 * Scan every token in the current chain's registry and return the ones
 * with a non-zero ERC-20 allowance granted to the OwlOrderFi router.
 *
 * Used by AllowanceManager so the user can audit + revoke standing
 * approvals from inside the app instead of being told to "go to your
 * wallet" (revoke.cash is the usual fallback today). Mirrors what a
 * security-conscious DeFi user would do manually.
 *
 * Background poll runs while the modal is open; manual refetch is
 * exposed for the post-revoke refresh so the row disappears as soon
 * as the on-chain allowance reflects the revoke tx.
 */

import { useAccount, useChainId, useReadContracts } from 'wagmi';
import { erc20Abi } from 'viem';
import { getTokens, type TokenInfo } from '../lib/tokens';
import { getRouterForChain } from '../lib/env';

export interface ActiveAllowance {
  token: TokenInfo;
  allowance: bigint;
}

interface UseAllowancesResult {
  allowances: ActiveAllowance[];
  isLoading: boolean;
  refetch: () => void;
}

export function useAllowances(enabled: boolean): UseAllowancesResult {
  const { address: owner } = useAccount();
  const chainId = useChainId();
  const tokens = getTokens(chainId);

  // The chain may not have a router configured (legacy / unsupported); in
  // that case we can't even ask the question, so bail out early with an
  // empty list rather than throwing.
  let router: `0x${string}` | undefined;
  try {
    router = getRouterForChain(chainId);
  } catch {
    router = undefined;
  }

  const contracts =
    owner && router
      ? tokens.map((t) => ({
          address: t.address as `0x${string}`,
          abi: erc20Abi,
          functionName: 'allowance' as const,
          args: [owner, router] as const,
          chainId,
        }))
      : [];

  const { data, isLoading, refetch } = useReadContracts({
    contracts,
    query: {
      enabled: enabled && contracts.length > 0,
      refetchInterval: 10_000,
    },
  });

  const allowances: ActiveAllowance[] = [];
  if (data) {
    for (let i = 0; i < tokens.length; i++) {
      const r = data[i];
      const t = tokens[i];
      if (!r || !t) continue;
      if (r.status === 'success' && typeof r.result === 'bigint' && r.result > 0n) {
        allowances.push({ token: t, allowance: r.result });
      }
    }
  }

  return { allowances, isLoading, refetch };
}
