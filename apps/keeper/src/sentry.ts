/**
 * Sentry telemetry for the keeper bot.
 *
 * The keeper is the most failure-sensitive piece: if it crashes, orders
 * silently stop executing. Sentry catches the stack trace and pages us
 * (via whatever notification rule we set in the Sentry dashboard).
 *
 * No-op when SENTRY_DSN is empty.
 */

import * as Sentry from '@sentry/node';
import { log } from './logger';

const DSN = process.env.SENTRY_DSN;

export function initSentry(): void {
  if (!DSN) {
    log.info('[sentry] SENTRY_DSN not set — telemetry disabled');
    return;
  }
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  log.info('[sentry] telemetry enabled');
}

// Wrapper so call sites don't need to import Sentry directly — keeps
// telemetry an opt-in concern that can be ripped out from one place.
export function captureKeeperError(err: unknown, context?: Record<string, unknown>): void {
  if (!DSN) return;
  if (context) {
    Sentry.withScope((scope) => {
      scope.setContext('keeper', context);
      Sentry.captureException(err);
    });
  } else {
    Sentry.captureException(err);
  }
}

// Flush before exit — Sentry buffers events; an immediate process.exit()
// would lose the last batch. Call this from your shutdown path.
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!DSN) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Swallow — we're already shutting down.
  }
}
