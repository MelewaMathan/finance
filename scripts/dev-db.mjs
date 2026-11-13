/**
 * Local PostgreSQL launcher (no Docker required).
 *
 * `embedded-postgres` ships official PostgreSQL binaries inside
 * node_modules/@embedded-postgres/<platform>/native. This script drives
 * `initdb` / `pg_ctl` directly instead of the wrapper API, which avoids the
 * package's postinstall symlink step (often blocked by npm policy) and gives
 * clear logs when something goes wrong.
 *
 * Usage:
 *   npm run db:up      # initialise once, start, keep running (Ctrl+C stops it)
 *   npm run db:down    # stop a stuck server
 *   npm run db:status  # probe the port
 *
 * With Docker/production, skip this and set DATABASE_URL to a real server.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function readEnv() {
  const envPath = path.join(root, '.env');
  const values = {};
  if (fs.existsSync(envPath)) {
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index === -1) continue;
      values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  return values;
}

const env = { ...readEnv(), ...process.env };
const port = Number(env.PG_PORT || 55432);
const dataDir = path.resolve(root, env.PG_DATA_DIR || '.pgdata');
const databases = ['secure_microfinance', 'secure_microfinance_test'];
// The binary package uses "windows-x64" naming, not Node's "win32-x64".
const platformName = process.platform === 'win32' ? 'windows' : process.platform;
const platform = `${platformName}-${process.arch}`;
const nativeDir = path.join(root, 'node_modules', '@embedded-postgres', platform, 'native');
const binDir = path.join(nativeDir, 'bin');
const exe = (name) => path.join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

function portOpen() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(800, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function run(command, args, label) {
  // Redirect to a log file instead of pipes: on Windows, PostgreSQL child
  // processes inherit the handles and keep pipes open, so spawnSync would
  // block forever even though the command already finished.
  const logFile = path.join(dataDir, 'cli.log');
  const fd = fs.openSync(logFile, 'w');
  const result = spawnSync(command, args, { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);

  const output = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  if (result.status !== 0) {
    console.error(`[db] ${label} failed (exit ${result.status})`);
    if (output.trim()) console.error(output.trim());
    process.exit(1);
  }
  return output.trim();
}

function assertBinaries() {
  if (!fs.existsSync(binDir)) {
    console.error(`[db] PostgreSQL binaries not found at ${binDir}`);
    console.error('[db] Run "npm install" first, or use Docker: docker compose up -d postgres');
    process.exit(1);
  }
}

async function createDatabases() {
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    for (const name of databases) {
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (exists.rowCount === 0) {
        // Identifiers cannot be parameterised; the names are hard-coded above.
        await client.query(`CREATE DATABASE ${name}`);
        console.log(`[db] created ${name}`);
      } else {
        console.log(`[db] ${name} already exists`);
      }
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const action = process.argv[2] || 'start';

  if (action === 'status') {
    const open = await portOpen();
    console.log(open ? `PostgreSQL listening on 127.0.0.1:${port}` : `No server on 127.0.0.1:${port}`);
    process.exit(open ? 0 : 1);
  }

  assertBinaries();
  fs.mkdirSync(dataDir, { recursive: true });

  if (action === 'stop') {
    console.log(run(exe('pg_ctl'), ['-D', dataDir, 'stop', '-m', 'fast'], 'pg_ctl stop') ?? '');
    console.log('[db] stopped');
    return;
  }

  if (await portOpen()) {
    console.log(`[db] server already running on 127.0.0.1:${port}`);
    await createDatabases();
    console.log(`[db] DATABASE_URL=postgresql://postgres@127.0.0.1:${port}/secure_microfinance`);
    return;
  }

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.log(`[db] initialising cluster at ${dataDir}`);
    run(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C'], 'initdb');
  }

  const logFile = path.join(dataDir, 'server.log');
  run(
    exe('pg_ctl'),
    ['-D', dataDir, '-l', logFile, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start'],
    'pg_ctl start',
  );
  console.log(`[db] PostgreSQL ready on 127.0.0.1:${port}`);

  await createDatabases();

  console.log(`\n[db] DATABASE_URL=postgresql://postgres@127.0.0.1:${port}/secure_microfinance`);
  console.log('[db] Press Ctrl+C to stop.\n');

  const shutdown = () => {
    console.log('\n[db] stopping PostgreSQL');
    spawnSync(exe('pg_ctl'), ['-D', dataDir, 'stop', '-m', 'fast'], { stdio: 'inherit' });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the launcher alive so Ctrl+C maps to a clean shutdown.
  setInterval(() => {}, 1 << 30);
}

main().catch((error) => {
  console.error('[db] failed:', error?.message ?? error);
  process.exit(1);
});
