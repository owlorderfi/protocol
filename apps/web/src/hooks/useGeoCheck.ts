/**
 * One-shot geo eligibility check.
 *
 * Calls GET /api/geo/check, which reads Cloudflare's CF-Connecting-IP +
 * CF-IPCountry headers server-side and matches against the same country
 * list + sub-national CIDR list backing the CF Custom Rules (A.4).
 *
 * Fail-open by design: if the API is unreachable, we treat the visitor
 * as not blocked. Real enforcement happens at the Hetzner FW + CF edge —
 * this hook only drives the UX overlay (so the user sees our honest
 * "service unavailable in your region" instead of a generic 403).
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface GeoCheckResult {
  blocked: boolean;
  reason: 'country' | 'subnational' | null;
}

export function useGeoCheck() {
  return useQuery({
    queryKey: ['geo-check'],
    queryFn: () => api<GeoCheckResult>('/geo/check', { auth: false }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
