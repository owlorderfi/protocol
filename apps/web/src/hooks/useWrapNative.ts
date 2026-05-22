import { useEffect } from 'react';
import {
  useAccount,
  useBalance,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import toast from 'react-hot-toast';
import { erc20Abi } from 'viem';
import { env } from '../lib/env';
import { WRAPPED_NATIVE } from '../lib/tokens';

/**
 * Wrap / unwrap the chain's native gas coin to its WETH9-style ERC20.
 *
 * Polygon's POL ↔ WPOL is the only pair we surface today; both follow the
 * canonical WETH9 ABI (deposit() payable, withdraw(uint256)). Returns null
 * if the current chain has no entry in WRAPPED_NATIVE — caller should
 * hide the panel in that case.
 */
const WRAP_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const;

export function useWrapNative() {
  const { address } = useAccount();
  const meta = WRAPPED_NATIVE[env.chainId];

  // Native gas-coin balance (POL on Polygon). useBalance with no `token`
  // returns the native one. Refetches piggyback off wagmi's block watcher.
  const { data: nativeBal, refetch: refetchNative } = useBalance({
    address,
    query: { enabled: !!address && !!meta },
  });

  // Wrapped ERC20 balance via balanceOf(address).
  const { data: wrappedBal, refetch: refetchWrapped } = useReadContract({
    address: meta?.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!meta },
  });

  const {
    writeContractAsync,
    data: txHash,
    isPending: isWriting,
    reset,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });

  // Refresh both balances when a wrap/unwrap tx confirms.
  useEffect(() => {
    if (!isSuccess) return;
    void refetchNative();
    void refetchWrapped();
    toast.success('Wrap/unwrap confirmed');
    reset();
  }, [isSuccess, refetchNative, refetchWrapped, reset]);

  if (!meta) {
    return null;
  }

  const wrap = async (amountWei: bigint): Promise<void> => {
    if (amountWei <= 0n) return;
    await writeContractAsync({
      address: meta.address,
      abi: WRAP_ABI,
      functionName: 'deposit',
      args: [],
      value: amountWei,
    });
  };

  const unwrap = async (amountWei: bigint): Promise<void> => {
    if (amountWei <= 0n) return;
    await writeContractAsync({
      address: meta.address,
      abi: WRAP_ABI,
      functionName: 'withdraw',
      args: [amountWei],
    });
  };

  return {
    meta,
    nativeBalance: nativeBal?.value ?? 0n,
    wrappedBalance: (wrappedBal as bigint | undefined) ?? 0n,
    wrap,
    unwrap,
    isPending: isWriting || isConfirming,
  };
}
