import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface SuspiciousIp {
  ip: string;
  requests_1h: number;
  unique_paths: number;
  errors: number;
  error_pct: number;
  user_agent: string;
  flags: string[];
}

export interface CaddySnapshot {
  total_1h: number;
  unique_ips_1h: number;
  top_ips: Array<{ ip: string; count: number; country: string }>;
  suspicious: SuspiciousIp[];
  country_distribution: Array<{ country: string; count: number }>;
  status_breakdown: Record<string, number>;
  top_200_paths: Array<{ path: string; count: number }>;
}

export interface MonitoringSnapshot {
  collected_at: string;
  caddy: CaddySnapshot;
}

export interface UsersStats {
  total_users: number;
  active_sessions: number;
  sessions_24h: number;
  new_users_7d: number;
  recent_logins: Array<{
    wallet_short: string;
    created_at: string;
  }>;
}

/**
 * Pull the live monitoring snapshot for the operator dashboard.
 * Wraps GET /api/admin/monitoring/snapshot?chainId=N (OwnerOnlyGuard
 * gated by the same chain check the rest of the admin tab uses).
 *
 * Refetch every 60s while the panel is mounted. Matches the SysGuard
 * pattern in docs/sysguard-traffic-monitoring-toolkit.md and trades
 * off "fresh enough" against not hammering the collector subprocess
 * on every operator interaction.
 */
export function useMonitoringSnapshot(chainId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'monitoring', 'snapshot', chainId],
    queryFn: async () => {
      if (!chainId) throw new Error('chainId required');
      return await api<MonitoringSnapshot>(
        `/admin/monitoring/snapshot?chainId=${chainId}`,
      );
    },
    enabled: enabled && !!chainId,
    refetchInterval: 60_000,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * Aggregated wallet / session stats. Lighter than the Caddy snapshot
 * (just a few count queries) so we can poll slightly faster — but 60s
 * also matches the panel cadence and keeps the operator's perception
 * "everything refreshes together".
 */
export function useUsersStats(chainId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'monitoring', 'users', chainId],
    queryFn: async () => {
      if (!chainId) throw new Error('chainId required');
      return await api<UsersStats>(
        `/admin/monitoring/users?chainId=${chainId}`,
      );
    },
    enabled: enabled && !!chainId,
    refetchInterval: 60_000,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
