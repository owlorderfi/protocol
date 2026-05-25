// Load .env WITHOUT overriding existing process.env. systemd's
// `Environment=CHAIN_ID=%i` (per-instance) MUST win over any
// CHAIN_ID accidentally left in the shared .env file — dotenv's
// `override: false` (default per docs) had a regression in 16.6.x
// where it overrode despite the flag; we set it explicitly to be
// defensive against both the regression and any future surprise.
import dotenv from 'dotenv';
dotenv.config({ override: false });

// Init telemetry before any other module loads so module-init errors
// are reportable too.
import { initSentry, captureKeeperError, flushSentry } from './sentry';
initSentry();

import { getConfig } from './config';
import { disconnectDb } from './db';
import { startPoller } from './poller';
import { startHealthServer } from './healthServer';
import { log } from './logger';

// Tracks the health server so shutdown() can close it cleanly.
let healthServer: import('node:http').Server | null = null;

async function main(): Promise<void> {
  const config = getConfig(); // throws on invalid env (incl. ONEINCH_API_KEY guard)
  // Lazy import so the registry lookup doesn't fire at module-load time
  // before getConfig() has validated CHAIN_ID.
  const { CHAINS } = await import('@owlorderfi/shared');
  const chainName = CHAINS[config.CHAIN_ID as keyof typeof CHAINS]?.name ?? 'unknown';

  log.info('══════════════════════════════════');
  log.info(`Polyorder Keeper starting [${config.KEEPER_INSTANCE_ID}]...`);
  log.info(`Chain:   ${config.CHAIN_ID} (${chainName})`);
  log.info(`Router:  ${config.LIMIT_ORDER_ROUTER_ADDRESS}`);
  log.info(`RPC:     ${config.RPC_URL}`);
  log.info(
    `PrivRPC: ${config.PRIVATE_RPC_URL ? config.PRIVATE_RPC_URL + ' (tx submission via private mempool)' : '(same as RPC — no MEV protection)'}`,
  );
  log.info(`DryRun:  ${config.DRY_RUN}`);
  log.info(`Prices:  Uniswap V3 QuoterV2 (on-chain)`);

  // Derive per-chain health port when HEALTH_PORT not explicitly set
  // — keeps two keeper instances on the same host from fighting over
  // port 4002. 4000 + chainId % 1000 yields 4002 for chain 84532
  // (Base Sepolia), 4614 for chain 421614 (Arb Sepolia), etc.
  const healthPort = config.HEALTH_PORT ?? (4000 + (config.CHAIN_ID % 1000));
  log.info(`Health:  http://0.0.0.0:${healthPort}/  (derived from chainId ${config.CHAIN_ID})`);
  log.info('══════════════════════════════════');

  healthServer = startHealthServer(healthPort);
  startPoller();
}

async function shutdown(signal: string): Promise<void> {
  log.info(`Received ${signal} — shutting down gracefully`);
  if (healthServer) {
    await new Promise<void>((resolve) =>
      healthServer!.close((err) => {
        if (err) log.warn('[health] close error:', err);
        resolve();
      }),
    );
  }
  await disconnectDb();
  await flushSentry();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
  captureKeeperError(err, { phase: 'uncaughtException' });
  void (async () => {
    await flushSentry();
    await disconnectDb();
    process.exit(1);
  })();
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
  captureKeeperError(reason, { phase: 'unhandledRejection' });
});

main().catch((err) => {
  log.error('Fatal startup error:', err);
  captureKeeperError(err, { phase: 'startup' });
  void flushSentry().finally(() => process.exit(1));
});
