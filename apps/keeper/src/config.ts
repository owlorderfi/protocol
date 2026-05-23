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
  MAX_CONCURRENT_ORDERS: z.coerce.number().int().positive().default(5),
  STUCK_EXECUTING_MINUTES: z.coerce.number().int().positive().default(5),
  GAS_HEADROOM_MULT: z.coerce.number().positive().default(1.5),
  GAS_BUMP_PCT: z.coerce.number().int().positive().default(20),
  TX_REPLACE_AFTER_SEC: z.coerce.number().int().positive().default(60),
  GAS_PRIORITY_FALLBACK_GWEI: z.coerce.number().positive().default(30),
  MAX_FEE_PER_GAS_GWEI: z.coerce.number().positive().default(500),
  HEALTH_PORT: z.coerce.number().int().positive().default(4002),
  ALERT_DISCORD_WEBHOOK: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  ALERT_PIPELINE_STUCK_MIN: z.coerce.number().int().positive().default(10),
  SLIPPAGE_GATE_BUFFER_BPS: z.coerce.number().int().nonnegative().default(50),
  KEEPER_INSTANCE_ID: z.string().default('keeper-0'),
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
