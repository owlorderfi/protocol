import { useMonitoringSnapshot, useUsersStats, type SuspiciousIp } from '../hooks/useMonitoring';
import { useAdminChain } from '../lib/AdminChainContext';

/**
 * Operator-only traffic monitoring panel. Surfaces the last hour of
 * Caddy access-log activity: total requests, unique IPs, and a table
 * of flagged "suspicious" IPs that triggered detection rules
 * (HIGH_RATE / ELEVATED_RATE / HIGH_ERRORS / BOT_UA / PATH_SCANNING —
 * see CaddyCollector in apps/api/src/monitoring/collectors/).
 *
 * Backend endpoint is gated by OwnerOnlyGuard at /api/admin/monitoring/snapshot,
 * so non-owner visitors who somehow reach this component still get a
 * 403 from the API. The UI shouldn't even mount for non-owners
 * (AdminInfoPanel checks isOwner before rendering), but defense in depth.
 *
 * Bundle 1β scope: live snapshot only, no history chart, no per-IP
 * ban action. Those land in Bundle 2/3 (see docs/pre-mainnet-hardening-plan.md).
 */
export function MonitoringPanel({ enabled }: { enabled: boolean }) {
  const { chainId } = useAdminChain();
  const snapshot = useMonitoringSnapshot(chainId, enabled);
  const users = useUsersStats(chainId, enabled);

  if (!enabled) return null;

  if (snapshot.isLoading) {
    return <div className="text-sm text-slate-500">Loading snapshot…</div>;
  }

  if (snapshot.isError) {
    return (
      <div className="text-sm text-rose-300">
        Could not load monitoring snapshot:{' '}
        {(snapshot.error as Error)?.message ?? 'unknown error'}
      </div>
    );
  }

  const data = snapshot.data;
  if (!data) return null;
  const { caddy, collected_at } = data;
  const collectedLabel = new Date(collected_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="space-y-4">
      {/* Top-line stats */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Requests / 1h" value={caddy.total_1h.toLocaleString()} />
        <Stat label="Unique IPs / 1h" value={caddy.unique_ips_1h.toLocaleString()} />
        <Stat
          label="Flagged"
          value={caddy.suspicious.length.toLocaleString()}
          tone={caddy.suspicious.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      <div className="text-xs text-slate-500">
        Last refreshed at {collectedLabel} · auto-refresh every 60s
      </div>

      {/* Suspicious table */}
      {caddy.suspicious.length === 0 ? (
        <div className="rounded-md border border-slate-800 bg-slate-900/30 p-3 text-sm text-slate-400">
          No flagged IPs in the last hour. The collector is watching
          for HIGH_RATE, BOT_UA, PATH_SCANNING, and HIGH_ERRORS patterns
          on the Caddy access log.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                <th className="px-2 py-2 text-left">IP</th>
                <th className="px-2 py-2 text-right">Req</th>
                <th className="px-2 py-2 text-right">Paths</th>
                <th className="px-2 py-2 text-right">Err %</th>
                <th className="px-2 py-2 text-left">Flags</th>
                <th className="px-2 py-2 text-left">UA</th>
              </tr>
            </thead>
            <tbody>
              {caddy.suspicious.map((row) => (
                <SuspiciousRow key={row.ip} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Country distribution — short bar list, last hour */}
      {caddy.country_distribution.length > 0 && (
        <details className="text-sm text-slate-400" open>
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 hover:text-slate-300">
            Countries (last hour) · {caddy.country_distribution.length}
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {caddy.country_distribution.slice(0, 10).map((row) => {
              const pct = caddy.total_1h > 0
                ? Math.round((row.count / caddy.total_1h) * 1000) / 10
                : 0;
              return (
                <li key={row.country} className="flex items-center gap-2">
                  <span className="w-10 font-mono text-slate-200">{row.country}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-slate-800">
                    <div
                      className="h-full bg-cyan-500/60"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                  <span className="w-16 text-right font-mono text-slate-400">
                    {row.count} · {pct}%
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {/* Status code breakdown — quick overall health pulse */}
      {Object.keys(caddy.status_breakdown).length > 0 && (
        <details className="text-sm text-slate-400" open>
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 hover:text-slate-300">
            Status code breakdown
          </summary>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {Object.entries(caddy.status_breakdown)
              .sort((a, b) => Number(a[0]) - Number(b[0]))
              .map(([status, count]) => {
                const code = Number(status);
                const tone = code >= 500
                  ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                  : code >= 400
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                    : code >= 300
                      ? 'border-slate-600/40 bg-slate-700/20 text-slate-300'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
                return (
                  <span
                    key={status}
                    className={`rounded border px-2 py-1 font-mono ${tone}`}
                  >
                    {status}: {count}
                  </span>
                );
              })}
          </div>
        </details>
      )}

      {/* Top paths returning 200 — security audit: what is publicly accessible? */}
      {caddy.top_200_paths.length > 0 && (
        <details className="text-sm text-slate-400" open>
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 hover:text-slate-300">
            Top paths returning 200 · {caddy.top_200_paths.length}
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {caddy.top_200_paths.map((row) => {
              const pathShort = row.path.length > 80
                ? row.path.slice(0, 80) + '…'
                : row.path;
              return (
                <li
                  key={row.path}
                  className="flex justify-between gap-3 font-mono"
                >
                  <span
                    className="truncate text-slate-300"
                    title={row.path}
                  >
                    {pathShort}
                  </span>
                  <span className="text-slate-500">{row.count}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Security audit: anything here that looks sensitive should
            require auth. If you see an internal-looking path returning
            200 without a JWT, that's a misconfigured gate.
          </p>
        </details>
      )}

      {/* Top IPs by request count */}
      {caddy.top_ips.length > 0 && (
        <details className="text-sm text-slate-400">
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 hover:text-slate-300">
            Top IPs by request count · {caddy.top_ips.length}
          </summary>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {caddy.top_ips.slice(0, 15).map((row) => (
              <li key={row.ip} className="flex justify-between">
                <span className="text-slate-300">{row.ip}</span>
                <span className="text-slate-500">{row.country}</span>
                <span className="text-slate-400">{row.count}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Wallet / session stats */}
      <div className="border-t border-slate-800 pt-3">
        <div className="mb-2 text-xs uppercase tracking-wider text-slate-500">
          Wallets &amp; sessions
        </div>
        {users.isLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : users.data ? (
          <>
            <div className="grid grid-cols-4 gap-2 text-sm">
              <SmallStat label="Total wallets" value={users.data.total_users} />
              <SmallStat label="Active sessions" value={users.data.active_sessions} />
              <SmallStat label="Sessions 24h" value={users.data.sessions_24h} />
              <SmallStat label="New users 7d" value={users.data.new_users_7d} />
            </div>

            {users.data.recent_logins.length > 0 && (
              <details className="mt-3 text-sm text-slate-400">
                <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 hover:text-slate-300">
                  Recent logins · {users.data.recent_logins.length}
                </summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {users.data.recent_logins.map((row, idx) => (
                    <li
                      key={`${row.wallet_short}-${row.created_at}-${idx}`}
                      className="flex justify-between font-mono"
                    >
                      <span className="text-slate-300">{row.wallet_short}</span>
                      <span className="text-slate-500">
                        {new Date(row.created_at).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : (
          <div className="text-sm text-slate-500">No data.</div>
        )}
      </div>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/30 p-2 text-center">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 font-mono text-base text-slate-200">{value}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'crit';
}) {
  const toneClass =
    tone === 'crit'
      ? 'text-rose-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'ok'
          ? 'text-emerald-300'
          : 'text-slate-200';
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/30 p-3">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 font-mono text-xl ${toneClass}`}>{value}</div>
    </div>
  );
}

function SuspiciousRow({ row }: { row: SuspiciousIp }) {
  // Truncate the UA so the table doesn't blow out horizontally on
  // verbose Chrome strings. Full text in title hover.
  const uaShort = row.user_agent.length > 40
    ? row.user_agent.slice(0, 40) + '…'
    : row.user_agent;

  return (
    <tr className="border-b border-slate-800/40">
      <td className="px-2 py-2 font-mono text-slate-200">{row.ip}</td>
      <td className="px-2 py-2 text-right font-mono text-slate-300">{row.requests_1h}</td>
      <td className="px-2 py-2 text-right font-mono text-slate-300">{row.unique_paths}</td>
      <td className="px-2 py-2 text-right font-mono text-slate-300">{row.error_pct}</td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap gap-1">
          {row.flags.length === 0 ? (
            <span className="text-xs text-slate-500">—</span>
          ) : (
            row.flags.map((f) => <FlagBadge key={f} flag={f} />)
          )}
        </div>
      </td>
      <td
        className="px-2 py-2 text-xs text-slate-500"
        title={row.user_agent}
      >
        {uaShort}
      </td>
    </tr>
  );
}

function FlagBadge({ flag }: { flag: string }) {
  const critical = flag === 'HIGH_RATE' || flag === 'HIGH_ERRORS';
  const warning =
    flag === 'ELEVATED_RATE' || flag === 'PATH_SCANNING' || flag === 'BOT_UA';
  const cls = critical
    ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
    : warning
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : 'bg-slate-700/30 text-slate-300 border-slate-600/40';
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-xs font-medium uppercase tracking-wider ${cls}`}
    >
      {flag}
    </span>
  );
}
