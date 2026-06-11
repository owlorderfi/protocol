/**
 * GeoGate — frontend overlay that honestly explains a region block,
 * instead of letting the user hit a generic 403 from Cloudflare.
 *
 * Mounted around the whole app. While the geo check is in flight (one
 * shot at first load, fast in practice), the app renders normally —
 * brief flash beats showing a "checking your region…" spinner that
 * looks invasive. Once the check resolves and `blocked` is true, the
 * overlay covers everything with a calm, plain explanation.
 *
 * No bypass / no "I'm not in that region" affordance. That would be
 * security theatre — and the real blocking still happens at the edge
 * (CF Custom Rules + Hetzner FW + UFW). This overlay is UX honesty
 * only, for the visitors who slip through the edge for any reason
 * (GeoLite2 misses, CF outage windows, etc.) but are still in a
 * sanctioned region by the API's server-side check.
 */

import { ReactNode } from 'react';
import { useGeoCheck } from '../hooks/useGeoCheck';

export function GeoGate({ children }: { children: ReactNode }) {
  const { data } = useGeoCheck();

  if (data?.blocked) {
    return <RegionUnavailable />;
  }
  return <>{children}</>;
}

function RegionUnavailable() {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="geo-block-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950 px-6"
    >
      <div className="max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-8 text-center shadow-xl">
        <h1
          id="geo-block-title"
          className="text-xl font-semibold tracking-tight text-slate-100"
        >
          Service unavailable in your region
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-300">
          OwlOrderFi is not available in your jurisdiction. Access from
          certain regions is restricted for regulatory compliance.
        </p>
        <p className="mt-4 text-xs text-slate-500">
          See{' '}
          <a
            href="/terms"
            target="_blank"
            rel="noopener"
            className="text-cyan-400 underline-offset-2 hover:text-cyan-300 hover:underline"
          >
            Terms
          </a>{' '}
          for the jurisdictional notice in full.
        </p>
      </div>
    </div>
  );
}
