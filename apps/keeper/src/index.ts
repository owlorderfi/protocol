import 'dotenv/config';
import { getConfig } from './config';
import { disconnectDb } from './db';
import { startPoller } from './poller';
import { startHealthServer } from './healthServer';
import { log } from './logger';

async function main(): Promise<void> {
  const config = getConfig(); // throws on invalid env (incl. ONEINCH_API_KEY guard)

  log.info('══════════════════════════════════');
  log.info('Polyorder Keeper starting...');
  log.info(`Chain:   ${config.CHAIN_ID}`);
  log.info(`Router:  ${config.LIMIT_ORDER_ROUTER_ADDRESS}`);
  log.info(`RPC:     ${config.RPC_URL}`);
  log.info(`DryRun:  ${config.DRY_RUN}`);
  log.info(`Prices:  Uniswap V3 QuoterV2 (on-chain)`);
  log.info('══════════════════════════════════');

  startHealthServer(config.HEALTH_PORT);
  startPoller();
}

async function shutdown(signal: string): Promise<void> {
  log.info(`Received ${signal} — shutting down gracefully`);
  await disconnectDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
  void disconnectDb().finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});
