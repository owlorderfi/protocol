/**
 * Unit tests for the geo CIDR/IP parsing — pins the IPv4-mapped IPv6 fix
 * (2026-06-11). Before the fix, parseIp('::ffff:1.2.3.4') ran the dotted-quad
 * tail through parseInt(..., 16) and silently produced a wrong value, so the
 * address matched neither v4 nor v6 sub-national CIDRs.
 */

import { describe, it, expect } from 'vitest';
import { parseIp } from './geo.service.js';

function v4(ip: string): bigint {
  return ip.split('.').reduce<bigint>((a, x) => (a << 8n) | BigInt(parseInt(x, 10)), 0n);
}

describe('parseIp', () => {
  it('parses a plain IPv4', () => {
    expect(parseIp('1.2.3.4')).toEqual({ family: 4, value: v4('1.2.3.4') });
  });

  it('parses a plain IPv6', () => {
    const r = parseIp('2606:4700::1');
    expect(r?.family).toBe(6);
    expect(r?.value).toBeGreaterThan(0n);
  });

  it('treats IPv4-mapped IPv6 (::ffff:1.2.3.4) as IPv4 with the correct value', () => {
    const r = parseIp('::ffff:1.2.3.4');
    expect(r).toEqual({ family: 4, value: v4('1.2.3.4') });
    // The pre-fix bug produced family 6 with a mangled value (tail parsed as 1).
    expect(r?.value).not.toBe(1n);
  });

  it('IPv4-mapped matches the same value as the bare IPv4 (so it hits v4 CIDRs)', () => {
    expect(parseIp('::ffff:8.8.8.8')?.value).toBe(parseIp('8.8.8.8')?.value);
  });

  it('returns null for a non-IP string', () => {
    expect(parseIp('not-an-ip')).toBeNull();
  });

  it('handles uppercase IPv4-mapped prefix (::FFFF:1.2.3.4)', () => {
    expect(parseIp('::FFFF:1.2.3.4')).toEqual({ family: 4, value: v4('1.2.3.4') });
  });
});
