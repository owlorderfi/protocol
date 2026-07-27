-- Audit finding #1: `maxSlippageBps` was signed by the maker but never read
-- on-chain, so it constrained nobody. The router now measures each slice
-- against a Uniswap V3 TWAP, and the maker signs which pool and over what
-- window -- so the keeper cannot pick a reference that flatters its fill.
--
-- Both columns are part of the EIP-712 payload and must round-trip exactly,
-- or the stored signature stops verifying.
--
-- Additive with defaults, so existing rows stay valid: the zero address is
-- the same "no on-chain reference" opt-out the contract understands, which is
-- exactly the behaviour rows signed before this change were signed under.
ALTER TABLE "scheduled_orders"
    ADD COLUMN "twapPool" VARCHAR(42) NOT NULL
        DEFAULT '0x0000000000000000000000000000000000000000',
    ADD COLUMN "twapWindowSec" INTEGER NOT NULL DEFAULT 0;
