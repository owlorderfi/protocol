import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

interface WhoamiResponse {
  chainId: number;
  owner: string;
  walletAddress: string;
  isOwner: boolean;
}

/**
 * Probe the API for `isOwner` status on the given chain. Cheap call
 * (JWT-only, no on-chain work beyond the cached owner read).
 *
 * Returns undefined while loading or when unauthed. The caller should
 * gate any admin UI on `data?.isOwner === true` — never trust a
 * truthy `data` alone, since a non-owner authenticated user still
 * gets a 200 response with `isOwner: false`.
 */
export function useAdminWhoami(chainId: number | undefined, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'whoami', chainId],
    queryFn: async () => {
      if (!chainId) throw new Error('chainId required');
      return await api<WhoamiResponse>(`/admin/whoami?chainId=${chainId}`);
    },
    enabled: enabled && !!chainId,
    // Owner address on-chain rarely changes. Re-check every 5 min just
    // in case of a transferOwnership, but no aggressive refetch.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export interface KeeperHealth {
  status: string;
  uptime_seconds: number;
  last_poll_at: string | null;
  last_fill_at: string | null;
  orders_polled: number;
  orders_triggered: number;
  tx_submitted: number;
  tx_replaced: number;
  open_orders: number;
}

/**
 * Poll the keeper's /health JSON via the admin proxy. The proxy
 * endpoint enforces owner-only access — non-owners get 403 here
 * regardless of what the frontend renders.
 *
 * Cadence matches the original dashboard's 5s refresh. Pauses when
 * `enabled` is false (e.g. tab not active) to avoid wasted polling.
 */
export function useKeeperHealth(chainId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'keeper-health', chainId],
    queryFn: async () => {
      if (!chainId) throw new Error('chainId required');
      return await api<KeeperHealth>(`/admin/keeper-health?chainId=${chainId}`);
    },
    enabled: enabled && !!chainId,
    refetchInterval: enabled ? 5_000 : false,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
