-- Pool spot price snapshots — every-5-min cron writes one row per
-- (chain, pair) so the web's Smart Suggest can derive a longer-horizon
-- (1h) trend signal without an extra RPC per Wait-pill click.
--
-- Match-window math (see MarketSnapshotService docstring): the trend
-- is computed over exactly the requested horizon, no extrapolation.
-- Wait=1h reads ~12 samples back. Retention 7d gives Smart Suggest's
-- ≤4h window generous headroom and leaves room for a future UI ribbon.

CREATE TABLE "pool_spot_snapshots" (
    "chain_id" INTEGER NOT NULL,
    "token_in" CHAR(42) NOT NULL,
    "token_out" CHAR(42) NOT NULL,
    "price_scaled" VARCHAR(80) NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_spot_snapshots_pkey" PRIMARY KEY ("chain_id", "token_in", "token_out", "ts")
);

-- Hot path: "give me the snapshot closest to (now - 1h)" — descending-ts
-- compound index against this scan.
CREATE INDEX "pool_spot_snapshots_chain_id_token_in_token_out_ts_idx"
  ON "pool_spot_snapshots"("chain_id", "token_in", "token_out", "ts" DESC);
