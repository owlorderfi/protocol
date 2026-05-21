import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { erc20Abi, maxUint256 } from 'viem';
import { env } from '../lib/env';

/**
 * Track + manage ERC20 allowance for the LimitOrderRouter on a given token.
 *
 * - `allowance` is the on-chain value (refetched after each tx)
 * - `needsApproval(amountRaw)` checks if current allowance covers the amount
 * - `approve()` triggers a max-uint256 approval via the wallet
 */
export function useTokenApproval(tokenAddress: `0x${string}` | undefined) {
  const { address: owner } = useAccount();

  const {
    data: allowance,
    refetch: refetchAllowance,
    isLoading: isLoadingAllowance,
  } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: owner && tokenAddress ? [owner, env.routerAddress] : undefined,
    query: { enabled: !!owner && !!tokenAddress },
  });

  const {
    writeContractAsync,
    data: txHash,
    isPending: isWriting,
    error: writeError,
    reset: resetWrite,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });

  // After tx confirms, refetch allowance to reflect new state
  if (isSuccess && allowance !== maxUint256) {
    refetchAllowance();
  }

  const approve = async (): Promise<void> => {
    if (!tokenAddress) return;
    resetWrite();
    await writeContractAsync({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [env.routerAddress, maxUint256],
    });
  };

  const needsApproval = (amountRaw: bigint): boolean => {
    if (allowance === undefined) return true;
    return allowance < amountRaw;
  };

  return {
    allowance: allowance ?? 0n,
    isLoadingAllowance,
    approve,
    isApproving: isWriting || isConfirming,
    approveError: writeError?.message ?? null,
    needsApproval,
  };
}
