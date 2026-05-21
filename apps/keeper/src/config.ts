import { z } from 'zod';

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    CHAIN_ID: z.coerce.number().int().positive(),
    RPC_URL: z.string().url(),
    PRIVATE_RPC_URL: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined))
      .pipe(z.string().url().optional()),
    KEEPER_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be 0x-prefixed 32-byte hex private key')
      .transform((s) => s as `0x${string}`),
    LIMIT_ORDER_ROUTER_ADDRESS: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .transform((s) => s as `0x${string}`),
    // Optional, unused since the keeper switched to direct Uniswap V3 quoting.
    // Kept so old .env files don't break parsing.
    ONEINCH_API_KEY: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(2),
    MAX_CONCURRENT_ORDERS: z.coerce.number().int().positive().default(5),
    STUCK_EXECUTING_MINUTES: z.coerce.number().int().positive().default(5),
    // Gas / tx replacement (EIP-1559 strategy)
    GAS_HEADROOM_MULT: z.coerce.number().positive().default(1.5),
    GAS_BUMP_PCT: z.coerce.number().int().positive().default(20),
    TX_REPLACE_AFTER_SEC: z.coerce.number().int().positive().default(60),
    HEALTH_PORT: z.coerce.number().int().positive().default(4002),
    // Stuck-pipeline alerting (Discord webhook). Empty → alerts disabled.
    ALERT_DISCORD_WEBHOOK: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
    ALERT_PIPELINE_STUCK_MIN: z.coerce.number().int().positive().default(10),
    DRY_RUN: z
      .string()
      .toLowerCase()
      .transform((v) => v === 'true' || v === '1')
      .default('false'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  });

export type Config = z.infer<typeof EnvSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid keeper configuration:\n${errors}`);
  }
  _config = result.data;
  return _config;
}
