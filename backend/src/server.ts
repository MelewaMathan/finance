import { createApp } from './app';
import { config } from './config/env';
import { runMigrations } from './db/migrate';
import { pool } from './db/pool';
import { isChainEnabled } from './modules/ledger/chain.client';

const app = createApp();

async function start() {
  try {
    await runMigrations();
  } catch (err) {
    console.error('[api] migration failed on startup:', err);
  }

  const server = app.listen(config.API_PORT, () => {
    console.log(`[api] listening on http://127.0.0.1:${config.API_PORT} (${config.NODE_ENV})`);
    console.log(`[api] docs: http://127.0.0.1:${config.API_PORT}/api/docs`);
    console.log(`[api] ledger mode: ${config.CHAIN_MODE}${isChainEnabled() ? '' : ' (chain writes disabled)'}`);
  });

  async function shutdown(signal: string): Promise<void> {
    console.log(`[api] ${signal} received, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => undefined);
      process.exit(0);
    });
    // Never hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void start();
