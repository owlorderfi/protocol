/**
 * GeoService — server-side jurisdiction check for the frontend banner.
 *
 * Defense layer 4 in the A.4 stack. Catches the cases that the edge
 * blocking layers (Hetzner FW + CF Custom Rules) don't:
 *   - GeoLite2 misses (~5-10%): sanctioned-region IP labelled country-only,
 *     no sub-national subdivision in MaxMind data → trickles past CF.
 *   - CF outage windows.
 *   - Operator UX: even when CF DOES block, the user sees a generic 403.
 *     Letting the frontend render our own banner is more honest.
 *
 * Source of truth for the lists:
 *   - Country tier (Tier 1): GEO_BLOCKED_COUNTRIES env var (CSV, default
 *     'IR,KP,CU,SY'). Mirrors the CF Custom Rule 'OFAC sanctions geo-block'.
 *   - Sub-national tier (Tier 2): GEO_BLOCKED_CIDR_FILE points at the
 *     same file we uploaded to the CF IP List 'sanctioned_subnational'.
 *     Refreshed annually via ops/ops/scripts/refresh-sanctions-cidr-list.py.
 *
 * If the env vars are unset or the CIDR file is missing, the check
 * silently degrades to "not blocked" — fail-open. Acceptable because the
 * edge layers (Hetzner FW + CF rules) are still doing the real blocking;
 * this layer is UX honesty, not the security floor.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';

interface ParsedCIDR {
  family: 4 | 6;
  network: bigint;
  mask: bigint;
}

export interface GeoCheckResult {
  blocked: boolean;
  /** Which tier triggered the block. Null when not blocked. */
  reason: 'country' | 'subnational' | null;
}

@Injectable()
export class GeoService implements OnModuleInit {
  private readonly logger = new Logger(GeoService.name);
  private blockedCountries = new Set<string>();
  private blockedCidrs: ParsedCIDR[] = [];

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // Country list. Default mirrors the CF Tier 1 rule; the env var
    // lets the operator sync changes without a code change.
    const raw = this.config.get<string>('GEO_BLOCKED_COUNTRIES') ?? 'IR,KP,CU,SY';
    this.blockedCountries = new Set(
      raw
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    );
    this.logger.log(`country block list: ${[...this.blockedCountries].join(',')}`);

    // Sub-national CIDR file. Optional — when unset, only country-level
    // blocking is active and the service logs a warning so the operator
    // notices the misconfiguration in monitoring.
    const cidrFile = this.config.get<string>('GEO_BLOCKED_CIDR_FILE');
    if (!cidrFile) {
      this.logger.warn(
        'GEO_BLOCKED_CIDR_FILE unset — sub-national check inactive (Tier 1 still on)',
      );
      return;
    }
    try {
      const lines = readFileSync(cidrFile, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      this.blockedCidrs = lines
        .map(parseCIDR)
        .filter((x): x is ParsedCIDR => x !== null);
      this.logger.log(`loaded ${this.blockedCidrs.length} sub-national CIDRs from ${cidrFile}`);
    } catch (err) {
      this.logger.error(`failed to load CIDR file ${cidrFile} — sub-national check inactive`, err);
    }
  }

  /**
   * Decide whether a visitor is in a blocked jurisdiction.
   *
   * @param ip Visitor's IP (read from CF-Connecting-IP at the controller).
   * @param country ISO 3166-1 alpha-2 from CF-IPCountry. Uppercase by spec.
   */
  check(ip: string | undefined, country: string | undefined): GeoCheckResult {
    if (country && this.blockedCountries.has(country.toUpperCase())) {
      return { blocked: true, reason: 'country' };
    }
    if (ip && this.matchesCidr(ip)) {
      return { blocked: true, reason: 'subnational' };
    }
    return { blocked: false, reason: null };
  }

  private matchesCidr(ip: string): boolean {
    const parsed = parseIp(ip);
    if (!parsed) return false;
    for (const cidr of this.blockedCidrs) {
      if (cidr.family !== parsed.family) continue;
      if ((parsed.value & cidr.mask) === cidr.network) return true;
    }
    return false;
  }
}

// ─── pure-TS CIDR matching (no extra deps) ────────────────────────

function parseCIDR(cidr: string): ParsedCIDR | null {
  const slash = cidr.indexOf('/');
  if (slash < 0) return null;
  const addr = cidr.slice(0, slash);
  const prefixLen = parseInt(cidr.slice(slash + 1), 10);

  if (isIPv4(addr)) {
    return buildCidr(ipv4ToBigInt(addr), prefixLen, 32n, 4);
  }
  if (isIPv6(addr)) {
    return buildCidr(ipv6ToBigInt(addr), prefixLen, 128n, 6);
  }
  return null;
}

function buildCidr(
  ip: bigint,
  prefixLen: number,
  totalBits: bigint,
  family: 4 | 6,
): ParsedCIDR {
  const allOnes = (1n << totalBits) - 1n;
  const hostBits = totalBits - BigInt(prefixLen);
  const mask = allOnes ^ ((1n << hostBits) - 1n);
  return { family, network: ip & mask, mask };
}

function parseIp(ip: string): { family: 4 | 6; value: bigint } | null {
  if (isIPv4(ip)) return { family: 4, value: ipv4ToBigInt(ip) };
  if (isIPv6(ip)) return { family: 6, value: ipv6ToBigInt(ip) };
  return null;
}

function ipv4ToBigInt(ip: string): bigint {
  return ip.split('.').reduce<bigint>(
    (acc, x) => (acc << 8n) | BigInt(parseInt(x, 10)),
    0n,
  );
}

function ipv6ToBigInt(ip: string): bigint {
  const parts = ip.includes('::') ? expandIPv6(ip) : ip.split(':');
  if (parts.length !== 8) throw new Error(`invalid IPv6 group count: ${ip}`);
  let result = 0n;
  for (const part of parts) {
    result = (result << 16n) | BigInt(parseInt(part || '0', 16));
  }
  return result;
}

function expandIPv6(ip: string): string[] {
  const [left, right] = ip.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const fill = 8 - leftParts.length - rightParts.length;
  return [...leftParts, ...Array<string>(fill).fill('0'), ...rightParts];
}
