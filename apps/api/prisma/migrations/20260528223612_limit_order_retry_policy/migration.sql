-- Limit-order transient-retry accounting.
--
-- retryCount + lastFailedAt back the keeper's limit-order retry policy
-- (LIMIT_RETRY_BACKOFF_SEC / LIMIT_MAX_RETRIES). releaseLock bumps
-- retryCount + stamps lastFailedAt on each transient failure (slippage
-- gate, gas spike, re-quote error); the poller backs off between attempts
-- and escalates the order to FAILED once retryCount hits the cap. Both
-- columns are additive: retryCount defaults 0, lastFailedAt is nullable,
-- so existing OPEN orders keep retrying as before until their next attempt.
--
-- Authored manually (not via `prisma migrate dev`) because a historic
-- squashed migration (20260521223302_add_order_fee_bps) duplicates the
-- CREATE TYPE statements from the initial migration, which crashes
-- Prisma's shadow-DB validation. The duplication is harmless in prod
-- (already applied + recorded in _prisma_migrations) but blocks the
-- shadow-DB rebuild that `migrate dev` requires. Manual migration
-- bypasses the shadow DB entirely. Same pattern as
-- 20260527153247_add_order_ladder_fields.

ALTER TABLE "orders" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "lastFailedAt" TIMESTAMP(3);
