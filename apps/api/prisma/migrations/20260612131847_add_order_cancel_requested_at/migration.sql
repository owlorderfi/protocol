-- Add the cooperative-cancel signal column to orders.
--
-- cancelRequestedAt lets a maker cancel an order even after the keeper has
-- claimed it (status EXECUTING). The OPEN -> CANCELLED cancel is already
-- race-free (atomic compare-and-swap, mutually exclusive with the keeper's
-- OPEN -> EXECUTING lock), but once the keeper holds the lock the maker can
-- no longer flip the status. The cancel endpoint stamps this timestamp
-- instead, and the keeper re-reads it immediately before broadcasting the
-- swap (mirroring scheduledExecutor's last-mile re-check) and aborts the
-- submit if set — turning the cancel into a real CANCELLED for free. NULL =
-- no cancel requested; existing orders stay NULL and behave unchanged.
--
-- Authored manually (not via `prisma migrate dev`) because a historic
-- squashed migration (20260521223302_add_order_fee_bps) duplicates the
-- CREATE TYPE statements from the initial migration, which crashes Prisma's
-- shadow-DB validation. Manual migration bypasses the shadow DB entirely.

ALTER TABLE "orders" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
