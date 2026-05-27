import { z } from 'zod';

/**
 * Keeper config — one process per chain.
 *
 * The keeper picks its chain via `CHAIN_ID` env. All chain-specific
 * values (RPC, router address, private mempool, WS) are read from a
 * `CHAIN_<id>_*` block — letting a single .env file hold deployments
 * for every chain we run on:
 *
 *   # Chain: Base Sepolia
 *   CHAIN_84532_RPC=https://sepolia.base.org
 *   CHAIN_84532_ROUTER=0x03e64...
 *
 *   # Chain: Polygon mainnet
 *   CHAIN_137_RPC=https://polygon-rpc.com
 *   CHAIN_137_PRIVATE_RPC=https://polygon.fastlane.xyz
 *   CHAIN_137_ROUTER=0x...
 *
 * Then start `polyorder-keeper-base-sepolia.service` with
 * `Environment=CHAIN_ID=84532`, `polyorder-keeper-polygon.service`
 * with `Environment=CHAIN_ID=137`, etc. — same .env, different chains.
 *
 * Backwards compat: legacy top-level RPC_URL / LIMIT_ORDER_ROUTER_ADDRESS
 * / PRIVATE_RPC_URL / WS_RPC_URL still work if no `CHAIN_<id>_*`
 * variant is set. Old deploys keep running unchanged; new ones can
 * migrate to the prefixed format incrementally.
 */

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const CommonEnvSchema = z.object({
  // ─── Common (operator-wide, chain-independent) ──────────────
  DATABASE_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  KEEPER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be 0x-prefixed 32-byte hex private key')
    .transform((s) => s as `0x${string}`),

  // Legacy single-chain vars — optional now (fall back if no
  // per-chain entry exists). Kept so existing deployments don't
  // break.
  RPC_URL: z.string().url().optional(),
  PRIVATE_RPC_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .pipe(z.string().url().optional()),
  LIMIT_ORDER_ROUTER_ADDRESS: z
    .string()
    .regex(HEX_ADDRESS_RE)
    .transform((s) => s as `0x${string}`)
    .optional(),
  WS_RPC_URL: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),

  // Optional, unused since the keeper switched to direct Uniswap V3 quoting.
  ONEINCH_API_KEY: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),

  // ─── Operational tuning (chain-independent) ─────────────────
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(2),
  // Cooldown before retrying a scheduled (DCA/TWAP) slice that failed
  // with a TRANSIENT reason (BREAK_EVEN_SKIP, GasTooHigh, RPC error).
  // 60s is a good Polygon/Base default — gas spikes usually clear within
  // a minute; shorter values just spam the RPC re-quoting. Permanent
  // failures (signature/deadline/cancelled) are NOT gated by this.
  SCHEDULED_RETRY_BACKOFF_SEC: z.coerce.number().int().positive().default(60),
  // Hard cap on transient retries for a single (orderId, sliceIndex) slot.
  // After this many FAILED transient rows we escalate the slot to permanent
  // and surface a Discord alert — past this point we're burning RPC on a
  // slice the contract keeps rejecting (typically slippage gate that won't
  // soften without maker action: raise maxSlippageBps or cancel).
  SCHEDULED_MAX_RETRIES: z.coerce.number().int().positive().default(15),
  MAX_CONCURRENT_ORDERS: z.coerce.number().int().positive().default(5),
  STUCK_EXECUTING_MINUTES: z.coerce.number().int().positive().default(5),
  GAS_HEADROOM_MULT: z.coerce.number().positive().default(1.5),
  // Safety factor for the gas LIMIT (not price). viem's estimateGas is
  // exact-fit and Uniswap V3 swaps can drift above it between estimation
  // and execution — without padding the limit, the tx OOGs and the
  // order silently fails. 1.3 = 30% headroom, cheap on L2s.
  GAS_LIMIT_HEADROOM_MULT: z.coerce.number().positive().default(1.3),
  GAS_BUMP_PCT: z.coerce.number().int().positive().default(20),
  TX_REPLACE_AFTER_SEC: z.coerce.number().int().positive().default(60),
  // Used ONLY when the RPC's estimateFeesPerGas() returns nothing
  // (rare). 1 gwei is a safe universal floor — Polygon mainnet
  // operators may want to raise to ~30 for hot-path priority via
  // CHAIN_<id>_PRIORITY_GWEI in a future iteration.
  GAS_PRIORITY_FALLBACK_GWEI: z.coerce.number().positive().default(1),
  MAX_FEE_PER_GAS_GWEI: z.coerce.number().positive().default(500),
  // Optional explicit health-server port. When unset, the keeper
  // derives a per-chain port at startup (4000 + CHAIN_ID % 1000) so
  // two instances on the same host don't collide on the default 4002.
  // Set this only when you want a specific number (e.g. behind a
  // pre-existing reverse proxy / monitoring scrape config).
  HEALTH_PORT: z.coerce.number().int().positive().optional(),
  ALERT_DISCORD_WEBHOOK: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  ALERT_PIPELINE_STUCK_MIN: z.coerce.number().int().positive().default(10),

  // ─── Keeper self-refill (paired with contract refillKeeper) ─────
  // Below this native balance, the keeper requests a top-up from the
  // contract's accumulated WETH reserve. Default 0.005 ETH (~$16 on
  // Base/Optimism at $3300 ETH) gives ~1000+ executes of runway on
  // Base at typical gas prices before the next refill triggers.
  KEEPER_BALANCE_THRESHOLD_WEI: z.coerce
    .bigint()
    .nonnegative()
    .default(BigInt('5000000000000000')), // 0.005 ether
  // Max wei the keeper asks for in a single refillKeeper call. Sized
  // smaller than the contract's `maxKeeperRefillPerDayWei` so a single
  // run can't hit the daily cap on its own (multiple smaller refills
  // = better failure isolation if RPC drops mid-call).
  KEEPER_REFILL_TRANCHE_WEI: z.coerce
    .bigint()
    .positive()
    .default(BigInt('10000000000000000')), // 0.01 ether
  // Minimum accumulated reserve worth pulling. Skipped if
  // accumulatedFees[wrapped] < this. Pulling tiny amounts is a net
  // loss — the refillKeeper tx itself costs gas (~80k * gasPrice).
  // On Base normal gas (0.001 gwei) that's ~8e10 wei; pulling less
  // than ~5x that is uneconomic. Default 1e15 wei = 0.001 ETH
  // (~$3 on mainnet) leaves plenty of headroom even on a gas spike.
  // Testnet operators can lower this to test the mechanism with
  // smaller amounts via CHAIN_<id>_REFILL_MIN_WORTH_WEI override
  // (not implemented yet — single global for now).
  KEEPER_REFILL_MIN_WORTH_WEI: z.coerce
    .bigint()
    .nonnegative()
    .default(BigInt('1000000000000000')), // 0.001 ether
  // Cadence (seconds) for the balance-check cron. Cheap RPC call —
  // 300s is more than fast enough for the typical drain rate.
  KEEPER_REFILL_CHECK_INTERVAL_SEC: z.coerce.number().int().positive().default(300),
  SLIPPAGE_GATE_BUFFER_BPS: z.coerce.number().int().nonnegative().default(50),
  KEEPER_INSTANCE_ID: z.string().default('keeper-0'),
  // RPC throttling: token-bucket + concurrency cap applied to every
  // HTTP-RPC call from this keeper instance. Defaults sized for
  // Alchemy free tier (25 rps hard cap per app) with margin for
  // burst smoothing. Bump on a paid Growth tier (250 CUPS).
  RPC_MAX_RPS: z.coerce.number().positive().default(15),
  RPC_MAX_CONCURRENT: z.coerce.number().int().positive().default(10),
  DRY_RUN: z
    .string()
    .toLowerCase()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

type CommonEnv = z.infer<typeof CommonEnvSchema>;

export type Config = CommonEnv & {
  RPC_URL: string;
  LIMIT_ORDER_ROUTER_ADDRESS: `0x${string}`;
  // PRIVATE_RPC_URL + WS_RPC_URL remain optional after resolution
};

let _config: Config | null = null;

/**
 * Resolve chain-specific values for the active CHAIN_ID. Prefers
 * `CHAIN_<id>_*` env vars; falls back to legacy single-chain vars.
 * Throws with a clear message when a required value is missing on
 * both paths.
 */
function resolveChainVars(common: CommonEnv): {
  RPC_URL: string;
  PRIVATE_RPC_URL: string | undefined;
  LIMIT_ORDER_ROUTER_ADDRESS: `0x${string}`;
  WS_RPC_URL: string | undefined;
} {
  const env = process.env;
  const chainId = common.CHAIN_ID;

  const rpc = env[`CHAIN_${chainId}_RPC`] ?? common.RPC_URL;
  if (!rpc) {
    throw new Error(
      `No RPC configured for chainId ${chainId}. ` +
        `Set CHAIN_${chainId}_RPC in apps/keeper/.env (or legacy RPC_URL).`,
    );
  }

  const router = env[`CHAIN_${chainId}_ROUTER`] ?? common.LIMIT_ORDER_ROUTER_ADDRESS;
  if (!router) {
    throw new Error(
      `No router address configured for chainId ${chainId}. ` +
        `Set CHAIN_${chainId}_ROUTER in apps/keeper/.env (or legacy LIMIT_ORDER_ROUTER_ADDRESS).`,
    );
  }
  if (!HEX_ADDRESS_RE.test(router)) {
    throw new Error(`CHAIN_${chainId}_ROUTER must be a 0x-prefixed 20-byte address (got "${router}")`);
  }

  const privateRpc = env[`CHAIN_${chainId}_PRIVATE_RPC`] ?? common.PRIVATE_RPC_URL;
  const wsRpc = env[`CHAIN_${chainId}_WS_RPC`] ?? common.WS_RPC_URL;

  return {
    RPC_URL: rpc,
    PRIVATE_RPC_URL: privateRpc && privateRpc.length > 0 ? privateRpc : undefined,
    LIMIT_ORDER_ROUTER_ADDRESS: router as `0x${string}`,
    WS_RPC_URL: wsRpc && wsRpc.length > 0 ? wsRpc : undefined,
  };
}

export function getConfig(): Config {
  if (_config) return _config;

  const result = CommonEnvSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid keeper configuration:\n${errors}`);
  }

  const common = result.data;
  const chainVars = resolveChainVars(common);

  _config = {
    ...common,
    ...chainVars,
  };
  return _config;
}
