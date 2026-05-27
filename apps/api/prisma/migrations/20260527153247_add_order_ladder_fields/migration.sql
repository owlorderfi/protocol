-- Add ladder grouping columns to orders.
--
-- ladderId + ladderRungIndex are persisted alongside each order so the
-- frontend can render N rungs of a take-profit / DCA-in ladder as one
-- group. The contract is unaware of ladders — each rung is a regular
-- LIMIT_BUY / LIMIT_SELL. Both columns are nullable; existing orders
-- (pre-feature) stay null and continue to behave as standalone limits.
--
-- Authored manually (not via `prisma migrate dev`) because a historic
-- squashed migration (20260521223302_add_order_fee_bps) duplicates the
-- CREATE TYPE statements from the initial migration, which crashes
-- Prisma's shadow-DB validation. The duplication is harmless in prod
-- (already applied + recorded in _prisma_migrations) but blocks the
-- shadow-DB rebuild that `migrate dev` requires. Manual migration
-- bypasses the shadow DB entirely.

ALTER TABLE "orders" ADD COLUMN "ladderId" UUID;
ALTER TABLE "orders" ADD COLUMN "ladderRungIndex" INTEGER;

CREATE INDEX "orders_ladderId_idx" ON "orders"("ladderId");
