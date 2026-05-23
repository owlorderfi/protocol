-- Add maker-signed price floor to scheduled orders.
-- Default "0" means "no floor enforced" (defense-in-depth disabled), so
-- existing rows remain valid; the on-chain check in executeScheduledOrder
-- treats 0 as a deliberate opt-out and skips the floor branch.
ALTER TABLE "scheduled_orders"
  ADD COLUMN "minPriceScaled" VARCHAR(80) NOT NULL DEFAULT '0';
