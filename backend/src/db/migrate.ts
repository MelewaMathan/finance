import fs from 'node:fs';
import path from 'node:path';
import { pool } from './pool';

/**
 * Tiny forward-only migration runner.
 *
 * Each file in src/db/migrations is applied once, inside its own transaction,
 * and recorded in schema_migrations. No ORM and no magic: the SQL files are
 * the source of truth so the schema stays reviewable for the security report.
 */
/**
 * Migrations are read from disk. `tsc` does not copy .sql files, so the Docker
 * image copies them next to the compiled output (see backend/Dockerfile). Hosts
 * that run `npm run build` and then `node dist/server.js` directly never make
 * that copy, so fall back to the source directory instead of dying with ENOENT.
 */
const migrationsDir =
  [
    path.resolve(__dirname, 'migrations'),
    path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),
  ].find((dir) => fs.existsSync(dir)) ?? path.resolve(__dirname, 'migrations');

export async function runMigrations({ reset = false }: { reset?: boolean } = {}): Promise<void> {
  const client = await pool.connect();
  try {
    if (reset) {
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');
      console.log('[migrate] schema dropped');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name),
    );

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
    }

    console.log('[migrate] up to date');
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  runMigrations({ reset })
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
