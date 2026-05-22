/**
 * Sentry error reporting for the web app.
 *
 * Init is lazy + gated on VITE_SENTRY_DSN: if the env var is empty
 * (dev, local builds, or whenever we just don't want telemetry),
 * everything degrades to no-op. No DSN = no network calls = no leak.
 *
 * Filters out noisy non-bugs:
 *   - Wallet rejection ("User denied transaction signature")
 *   - Wagmi / viem connection retries we already handle in UI
 *   - SES lockdown warnings from MetaMask injector
 */

import * as Sentry from '@sentry/react';

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

// User-action errors that shouldn't page anyone.
const IGNORED_MESSAGES = [
  /User rejected the request/i,
  /User denied transaction/i,
  /User rejected the transaction/i,
  /SES_UNCAUGHT_EXCEPTION/i, // MetaMask injector noise
  /ResizeObserver loop limit exceeded/i, // benign browser quirk
];

export function initSentry(): void {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE ?? undefined,
    tracesSampleRate: 0, // we only want errors, not perf, on free tier
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend(event, hint) {
      const msg = hint?.originalException
        ? String((hint.originalException as Error)?.message ?? hint.originalException)
        : event.message ?? '';
      if (IGNORED_MESSAGES.some((re) => re.test(msg))) return null;
      return event;
    },
  });
}

export const SentryErrorBoundary = Sentry.ErrorBoundary;
