import { useEffect } from 'react';
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import toast from 'react-hot-toast';
import { erc20Abi } from 'viem';
import { getRouterForChain } from '../lib/env';
import { WRAPPED_NATIVE } from '../lib/tokens';

/**
 * Wrap / unwrap the chain's native gas coin to its WETH9-style ERC20.
 *
 * Polygon's POL ↔ WPOL is the only pair we surface today; both follow the
 * canonical WETH9 ABI (deposit() payable, withdraw(uint256)). Returns null
 * if the current chain has no entry in WRAPPED_NATIVE — caller should
 * hide the panel in that case.
 *
 * Wrap goes straight to WPOL.deposit() (works for any account type).
 * Unwrap goes through our LimitOrderRouter.unwrap() instead of
 * WPOL.withdraw() directly — the WETH9 withdraw uses `.transfer(2300)`
 * which OOGs on EIP-7702 delegated accounts (Rabby Smart Account etc).
 * The router's unwrap uses `.call{value:}` with no gas restriction.
 * Requires the user to have approved the router on WPOL first.
 */
const WRAP_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;

const ROUTER_UNWRAP_ABI = [
  {
    type: 'function',
    name: 'unwrap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'wrappedNative', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export function useWrapNative() {
  const { address } = useAccount();
  const chainId = useChainId();
  const meta = WRAPPED_NATIVE[chainId];

  // Native gas-coin balance (POL on Polygon, ETH on Base). useBalance with
  // no `token` returns the native one. Polling every 10s as a safety net
  // — useWaitForTransactionReceipt's isSuccess event is intermittent on
  // L2s, and without polling the balances only refresh on full page reload.
  const { data: nativeBal, refetch: refetchNative } = useBalance({
    address,
    query: { enabled: !!address && !!meta, refetchInterval: 10_000 },
  });

  // Wrapped ERC20 balance via balanceOf(address). Same polling cadence
  // for the same reason.
  const { data: wrappedBal, refetch: refetchWrapped } = useReadContract({
    address: meta?.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!meta, refetchInterval: 10_000 },
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
      address: getRouterForChain(chainId),
      abi: ROUTER_UNWRAP_ABI,
      functionName: 'unwrap',
      args: [meta.address, amountWei],
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
