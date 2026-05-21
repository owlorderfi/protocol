import { useReadContract } from 'wagmi';
import { env } from '../lib/env';

const ROUTER_ABI = [
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
] as const;

/**
 * Current protocol fee in bps from the LimitOrderRouter. Refreshes on each
 * block via wagmi default. UI uses this to show the live fee % so any
 * setFeeBps() call by the owner is reflected immediately.
 */
export function useProtocolFee(): { feeBps: number | null; feePct: number | null } {
  const { data } = useReadContract({
    address: env.routerAddress,
    abi: ROUTER_ABI,
    functionName: 'feeBps',
  });

  if (data === undefined) return { feeBps: null, feePct: null };
  return { feeBps: Number(data), feePct: Number(data) / 100 };
}
