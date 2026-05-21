import { useAccount, useReadContract } from 'wagmi';
import { erc20Abi } from 'viem';

/**
 * Read the connected wallet's balance of a given ERC20 token.
 * Refetches every 8s and after each block — enough to feel live for a form.
 */
export function useTokenBalance(tokenAddress: `0x${string}` | undefined) {
  const { address } = useAccount();

  const { data, isLoading } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && !!tokenAddress,
      refetchInterval: 8_000,
    },
  });

  return {
    balance: data ?? 0n,
    isLoading,
  };
}
