import { useEffect, useState } from 'react';
import { useAccount, useChainId, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { erc20Abi, maxUint256 } from 'viem';
import { getRouterForChain } from '../lib/env';

/**
 * Track + manage ERC20 allowance for the LimitOrderRouter on a given token.
 *
 * - `allowance` is the on-chain value (refetched every 5s)
 * - `needsApproval(amountRaw)` checks if current allowance covers the amount
 * - `approve(amount?)` triggers an approval via the wallet. With no arg →
 *   max-uint256 (industry default, one approve covers every future order).
 *   With an arg → exact amount (paranoid mode, one approve per order; the
 *   caller passes a small buffer to absorb rounding/decimals quirks).
 * - `isApproving` stays true from the moment the user clicks Approve until
 *   the on-chain allowance reflects the requested value — covers every
 *   frame in between so the Approve button never reactivates and tricks
 *   the user into clicking + paying gas a second time.
 */
/**
 * @param tokenAddress     The ERC20 to read/manage approval for
 * @param otherCommitted   Allowance already earmarked by the user's
 *                         OTHER active orders on this token. Defaults
 *                         to 0n (single-order use case). When non-zero,
 *                         needsApproval treats the threshold as
 *                         `amountForThisOrder + otherCommitted` so
 *                         exact-mode users get prompted to top up
 *                         instead of racing siblings into a revert.
 */
export function useTokenApproval(
  tokenAddress: `0x${string}` | undefined,
  otherCommitted: bigint = 0n,
) {
  const { address: owner } = useAccount();
  const chainId = useChainId();
  const routerAddress = getRouterForChain(chainId);

  const {
    data: allowance,
    refetch: refetchAllowance,
    isLoading: isLoadingAllowance,
  } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: owner && tokenAddress ? [owner, routerAddress] : undefined,
    query: {
      enabled: !!owner && !!tokenAddress,
      // Background poll catches: approvals done in another tab, an
      // approve where useWaitForTransactionReceipt's isSuccess never
      // fires (intermittent on L2s), or anything else that races.
      // 5 sec is a good balance of latency vs RPC load.
      refetchInterval: 5000,
    },
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

  // Local intent flag: set synchronously the moment the user clicks Approve.
  // Cleared only when we OBSERVE the on-chain allowance reach the requested
  // amount (success) or when the write itself errors out (user rejection
  // etc.). Holds the target amount so we know what "success" means — exact
  // mode passes a specific amountIn, unlimited mode passes maxUint256.
  const [pendingApproval, setPendingApproval] = useState<bigint | null>(null);

  // Clear the intent once the chain confirms the new allowance has reached
  // (or passed) the requested target. Using >= so a prior unlimited approve
  // followed by a smaller exact approve still resolves cleanly.
  useEffect(() => {
    if (
      pendingApproval !== null &&
      allowance !== undefined &&
      allowance >= pendingApproval
    ) {
      setPendingApproval(null);
    }
  }, [pendingApproval, allowance]);

  // Clear the intent on write errors (user rejected, network failed, etc.).
  useEffect(() => {
    if (pendingApproval !== null && writeError) {
      setPendingApproval(null);
    }
  }, [pendingApproval, writeError]);

  // After approval tx confirms, refetch allowance immediately — without
  // waiting for the next refetchInterval tick.
  useEffect(() => {
    if (isSuccess && pendingApproval !== null && allowance !== undefined && allowance < pendingApproval) {
      void refetchAllowance();
      resetWrite();
    }
  }, [isSuccess, allowance, pendingApproval, refetchAllowance, resetWrite]);

  /**
   * Trigger an approval. `amount` is the target allowance:
   *   - omitted / undefined → maxUint256 (industry default, "approve once")
   *   - explicit bigint     → exact amount; caller responsible for adding a
   *     small buffer (typically 5%) to absorb decimals rounding
   */
  const approve = async (amount?: bigint): Promise<void> => {
    if (!tokenAddress) return;
    const target = amount ?? maxUint256;
    resetWrite();
    setPendingApproval(target);
    try {
      await writeContractAsync({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [routerAddress, target],
      });
    } catch (err) {
      // Rejection / failure — clear immediately so the button reactivates
      // and the user can retry. The writeError effect would catch this too
      // but the throw path is more deterministic.
      setPendingApproval(null);
      throw err;
    }
  };

  const needsApproval = (amountRaw: bigint): boolean => {
    // While the read is pending, return false so we don't flash the Approve
    // button before we know the real allowance.
    if (isLoadingAllowance || allowance === undefined) return false;
    return allowance < amountRaw + otherCommitted;
  };

  return {
    allowance: allowance ?? 0n,
    otherCommitted,
    isLoadingAllowance,
    approve,
    isApproving: isWriting || isConfirming || pendingApproval !== null,
    approveError: writeError?.message ?? null,
    needsApproval,
  };
}
