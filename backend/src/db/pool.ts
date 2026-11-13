import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from '../config/env';

/**
 * Single shared connection pool.
 * Every query in the codebase is parameterised ($1, $2 ...) -- there is no
 * string interpolation of user input anywhere, which removes SQL injection.
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  // A pooled client dying should never take the API process down.
  console.error('[db] idle client error', error);
});

// bigint (OID 20) is used for money in minor units. Values stay far below
// Number.MAX_SAFE_INTEGER, and returning numbers keeps the API JSON clean.
import { types } from 'pg';
types.setTypeParser(20, (value: string) => Number(value));
types.setTypeParser(1700, (value: string) => Number(value));

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params as never[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run `fn` inside a transaction; rolls back on any thrown error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
