import 'dotenv/config';
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
  const { CHAINS } = await import('@polyorder/shared');
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
  log.info('══════════════════════════════════');

  healthServer = startHealthServer(config.HEALTH_PORT);
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
