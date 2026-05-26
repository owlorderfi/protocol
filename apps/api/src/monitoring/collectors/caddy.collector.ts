import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';

/**
 * Parses the last hour's worth of Caddy access log entries (JSON format)
 * from `/var/log/caddy/polyorder.log` and surfaces per-IP request
 * patterns with detection flags.
 *
 * Ported from the SysGuard pattern (see
 * `docs/sysguard-traffic-monitoring-toolkit.md` § 3) but adapted:
 *   - Reads via Node fs (not subprocess `tail`) so we get integration with
 *     NestJS error handling + can swap to a fixture file for unit tests.
 *   - Uses `request.client_ip` which Caddy resolves from CF-Connecting-IP
 *     (A.7 deployment) — that's the real visitor IP, not the CF edge.
 *   - Tail-by-bytes (read last N MB) to avoid loading the entire file into
 *     memory on busy days. Keeps the collector under ~300ms on typical
 *     servers.
 *
 * Detection flags (from sysguard):
 *   HIGH_RATE        > 200 req/h  → almost certainly an attacker
 *   ELEVATED_RATE    > 60 req/h   → unusual but possibly legit
 *   HIGH_ERRORS      > 50% errors and > 5 errors  → scanner pattern
 *   BOT_UA           UA contains bot/crawler/spider/curl/wget/python  → bot
 *   PATH_SCANNING    > 50 unique paths  → directory enumeration
 */

const BOT_UA_PATTERNS = [
  'bot',
  'crawler',
  'spider',
  'scan',
  'curl',
  'wget',
  'python-requests',
  'go-http',
  'nmap',
];

interface SuspiciousIp {
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
}

@Injectable()
export class CaddyCollector {
  private readonly logger = new Logger(CaddyCollector.name);
  // Tail target. Read the last N bytes of the log to bound memory + parse
  // time. ~5 MB covers the last hour comfortably even at 5-10 req/s.
  private readonly TAIL_BYTES = 5 * 1024 * 1024;

  // Log path is a class field (not a constructor param) so NestJS DI
  // doesn't try to inject it as a String dependency. Override via env
  // CADDY_LOG_PATH for tests / fixture-driven dev.
  private readonly logPath: string =
    process.env.CADDY_LOG_PATH ?? '/var/log/caddy/polyorder.log';

  async collect(): Promise<CaddySnapshot> {
    const empty: CaddySnapshot = {
      total_1h: 0,
      unique_ips_1h: 0,
      top_ips: [],
      suspicious: [],
    };

    let text: string;
    try {
      // Read the tail of the file. fs.readFile with no length flag would
      // load the whole thing; we open + seek + read instead.
      const { open } = await import('node:fs/promises');
      const handle = await open(this.logPath, 'r');
      try {
        const stat = await handle.stat();
        const start = Math.max(0, stat.size - this.TAIL_BYTES);
        const buf = Buffer.alloc(stat.size - start);
        await handle.read(buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (err) {
      // ENOENT → log doesn't exist yet (fresh server or rotated).
      // EACCES → permissions (radu not in caddy group?).
      // Either case: report empty snapshot, don't crash.
      const code = (err as NodeJS.ErrnoException).code;
      this.logger.warn(
        `Cannot read Caddy log at ${this.logPath}: ${code ?? (err as Error).message}`,
      );
      return empty;
    }

    const now = Date.now() / 1000;
    const oneHour = 3600;

    const ipRequests = new Map<string, number>();
    const ipPaths = new Map<string, Set<string>>();
    const ipErrors = new Map<string, number>();
    const ipUserAgents = new Map<string, string>();
    const ipCountries = new Map<string, string>();
    let total = 0;

    // The first line in the tail may be a partial entry — skip it.
    const lines = text.split('\n');
    if (lines.length > 0) lines.shift();

    for (const line of lines) {
      if (!line || !line.includes('"handled request"')) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = (entry.ts as number) ?? 0;
      if (now - ts > oneHour) continue;

      const request = entry.request as Record<string, unknown> | undefined;
      if (!request) continue;
      const ip = (request.client_ip as string) ?? '';
      const uri = (request.uri as string) ?? '';
      const status = (entry.status as number) ?? 0;
      const headers = request.headers as Record<string, string[]> | undefined;
      const ua = headers?.['User-Agent']?.[0] ?? '';
      const country = headers?.['Cf-Ipcountry']?.[0] ?? '?';

      // Skip Docker / loopback noise.
      if (!ip || ip.startsWith('172.') || ip.startsWith('127.') || ip === '::1') {
        continue;
      }

      total += 1;
      ipRequests.set(ip, (ipRequests.get(ip) ?? 0) + 1);
      const pathOnly = uri.split('?')[0] ?? '';
      if (!ipPaths.has(ip)) ipPaths.set(ip, new Set());
      ipPaths.get(ip)!.add(pathOnly);
      if (status >= 400) {
        ipErrors.set(ip, (ipErrors.get(ip) ?? 0) + 1);
      }
      if (!ipUserAgents.has(ip)) {
        ipUserAgents.set(ip, ua.slice(0, 120));
      }
      if (!ipCountries.has(ip)) {
        ipCountries.set(ip, country);
      }
    }

    // Build top_ips and suspicious.
    const sorted = [...ipRequests.entries()].sort((a, b) => b[1] - a[1]);

    const top_ips = sorted.slice(0, 15).map(([ip, count]) => ({
      ip,
      count,
      country: ipCountries.get(ip) ?? '?',
    }));

    const suspicious: SuspiciousIp[] = [];
    for (const [ip, count] of sorted.slice(0, 30)) {
      const ua = ipUserAgents.get(ip) ?? '';
      const errors = ipErrors.get(ip) ?? 0;
      const paths_count = ipPaths.get(ip)?.size ?? 0;
      const error_pct = count > 0 ? Math.round((errors / count) * 1000) / 10 : 0;
      const ua_lower = ua.toLowerCase();
      const is_bot = BOT_UA_PATTERNS.some((b) => ua_lower.includes(b));

      const flags: string[] = [];
      if (count > 200) flags.push('HIGH_RATE');
      else if (count > 60) flags.push('ELEVATED_RATE');
      if (error_pct > 50 && errors > 5) flags.push('HIGH_ERRORS');
      if (is_bot) flags.push('BOT_UA');
      if (paths_count > 50) flags.push('PATH_SCANNING');

      if (flags.length > 0 || count > 30) {
        suspicious.push({
          ip,
          requests_1h: count,
          unique_paths: paths_count,
          errors,
          error_pct,
          user_agent: ua,
          flags,
        });
      }
    }

    return {
      total_1h: total,
      unique_ips_1h: ipRequests.size,
      top_ips,
      suspicious: suspicious.slice(0, 15),
    };
  }
}
