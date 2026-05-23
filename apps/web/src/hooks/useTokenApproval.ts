import { useEffect, useState } from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { erc20Abi, maxUint256 } from 'viem';
import { env } from '../lib/env';

/**
 * Track + manage ERC20 allowance for the LimitOrderRouter on a given token.
 *
 * - `allowance` is the on-chain value (refetched every 5s)
 * - `needsApproval(amountRaw)` checks if current allowance covers the amount
 * - `approve()` triggers a max-uint256 approval via the wallet
 * - `isApproving` stays true from the moment the user clicks Approve until
 *   the on-chain allowance reflects the new max value — covers every frame
 *   in between so the Approve button never reactivates and tricks the user
 *   into clicking + paying gas a second time.
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
  // Cleared only when we OBSERVE the on-chain allowance reach maxUint256
  // (success) or when the write itself errors out (user rejection etc.).
  // This guards against every wagmi-state race window:
  //   - writeContract resolves but `data` (txHash) updates one render later
  //     → without this, isWriting flips false before txHash appears, and
  //     the button briefly reactivates
  //   - useWaitForTransactionReceipt query takes a render to become enabled
  //     after txHash arrives, so isConfirming is briefly false
  // The flag covers both windows.
  const [pendingApproval, setPendingApproval] = useState(false);

  // Clear the intent once the chain confirms the new allowance.
  useEffect(() => {
    if (pendingApproval && allowance === maxUint256) {
      setPendingApproval(false);
    }
  }, [pendingApproval, allowance]);

  // Clear the intent on write errors (user rejected, network failed, etc.).
  useEffect(() => {
    if (pendingApproval && writeError) {
      setPendingApproval(false);
    }
  }, [pendingApproval, writeError]);

  // After approval tx confirms, refetch allowance immediately — without
  // waiting for the next refetchInterval tick.
  useEffect(() => {
    if (isSuccess && allowance !== maxUint256) {
      void refetchAllowance();
      resetWrite();
    }
  }, [isSuccess, allowance, refetchAllowance, resetWrite]);

  const approve = async (): Promise<void> => {
    if (!tokenAddress) return;
    resetWrite();
    setPendingApproval(true);
    try {
      await writeContractAsync({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [env.routerAddress, maxUint256],
      });
    } catch (err) {
      // Rejection / failure — clear immediately so the button reactivates
      // and the user can retry. The writeError effect would catch this too
      // but the throw path is more deterministic.
      setPendingApproval(false);
      throw err;
    }
  };

  const needsApproval = (amountRaw: bigint): boolean => {
    // While the read is pending, return false so we don't flash the Approve
    // button before we know the real allowance.
    if (isLoadingAllowance || allowance === undefined) return false;
    return allowance < amountRaw;
  };

  return {
    allowance: allowance ?? 0n,
    isLoadingAllowance,
    approve,
    isApproving: isWriting || isConfirming || pendingApproval,
    approveError: writeError?.message ?? null,
    needsApproval,
  };
}
