-- Retry policy for scheduled (DCA/TWAP) slice executions.
--
-- BEFORE: UNIQUE(scheduledOrderId, sliceIndex) blocked any retry —
-- once a slice failed (BREAK_EVEN_SKIP, gas spike, RPC blip), every
-- subsequent poll hit the unique constraint, silently bailed, and the
-- slice was stuck FAILED until someone deleted the row by hand.
--
-- AFTER:
--   - Partial unique constrains only PENDING/FILLED rows. Multiple
--     FAILED rows per (orderId, sliceIndex) are allowed → each retry
--     attempt is a fresh row with its own failureReason (audit trail).
--   - `permanent` boolean distinguishes "do not retry" failures
--     (signature invalid, deadline expired, order cancelled, maker
--     out of balance/allowance) from "retry after cooldown" failures
--     (BREAK_EVEN_SKIP, GasTooHigh, RPC errors).
--   - New (orderId, sliceIndex, executedAt) index makes the poller's
--     "find the latest failure for this slot" query trivial.

-- Drop both the constraint AND the underlying index. Prisma generates
-- @@unique as a plain index on some DBs (not a true CONSTRAINT), so
-- DROP CONSTRAINT alone silently misses it.
ALTER TABLE "scheduled_executions"
  DROP CONSTRAINT IF EXISTS "scheduled_executions_scheduledOrderId_sliceIndex_key";
DROP INDEX IF EXISTS "scheduled_executions_scheduledOrderId_sliceIndex_key";

CREATE UNIQUE INDEX "scheduled_executions_active_slot_unique"
  ON "scheduled_executions" ("scheduledOrderId", "sliceIndex")
  WHERE "status" IN ('PENDING', 'FILLED');

ALTER TABLE "scheduled_executions"
  ADD COLUMN "permanent" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "scheduled_executions_scheduledOrderId_sliceIndex_executedAt_idx"
  ON "scheduled_executions" ("scheduledOrderId", "sliceIndex", "executedAt");
