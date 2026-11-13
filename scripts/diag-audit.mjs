import pg from 'pg';

const client = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:55432/secure_microfinance' });
await client.connect();
const rows = await client.query('SELECT seq, action, created_at FROM audit_log ORDER BY seq DESC LIMIT 10');
console.table(rows.rows);
const count = await client.query('SELECT count(*)::int AS n FROM audit_log');
console.log('rows', count.rows[0]);
await client.end();
