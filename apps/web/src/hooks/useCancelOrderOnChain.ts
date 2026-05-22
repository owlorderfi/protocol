import { useEffect, useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { env } from '../lib/env';

/**
 * On-chain order cancel.
 *
 * LimitOrderRouter.cancelOrder(nonce) marks the maker's nonce as used,
 * so any subsequent executeOrder with that nonce reverts with
 * NonceAlreadyUsed. This is the only way to stop a tx the keeper has
 * already submitted — the off-chain DB cancel can't recall something
 * that's already in the mempool.
 *
 * Costs gas (sent from the maker's wallet) but guaranteed to stop a
 * race that the API cancel would lose to the keeper.
 */
const ROUTER_ABI = [
  {
    type: 'function',
    name: 'cancelOrder',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'nonce', type: 'uint256' }],
    outputs: [],
  },
] as const;

export function useCancelOrderOnChain() {
  const qc = useQueryClient();
  const [pendingNonce, setPendingNonce] = useState<string | null>(null);
  const { writeContractAsync, data: txHash, isPending: isWriting, reset } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });

  // When the cancel tx confirms, invalidate the orders list so the
  // keeper-side FAILED status surfaces; toast the user. Side-effect lives
  // in useEffect to satisfy React rules.
  useEffect(() => {
    if (isSuccess && pendingNonce !== null) {
      toast.success('On-chain cancel confirmed');
      void qc.invalidateQueries({ queryKey: ['orders'] });
      setPendingNonce(null);
      reset();
    }
  }, [isSuccess, pendingNonce, qc, reset]);

  const cancelOnChain = async (nonce: string): Promise<void> => {
    setPendingNonce(nonce);
    try {
      await writeContractAsync({
        address: env.routerAddress,
        abi: ROUTER_ABI,
        functionName: 'cancelOrder',
        args: [BigInt(nonce)],
      });
    } catch (err) {
      setPendingNonce(null);
      const msg = err instanceof Error ? err.message : String(err);
      // viem wraps user rejection — keep the toast short.
      if (msg.includes('User rejected')) {
        toast.error('Cancel rejected in wallet');
      } else {
        toast.error(`On-chain cancel failed: ${msg.slice(0, 120)}`);
      }
      throw err;
    }
  };

  return {
    cancelOnChain,
    isPending: isWriting || isConfirming,
  };
}
