import pg from 'pg';
import { env } from './env.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export type Row = Record<string, any>;

export async function query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query<T>(text, params as any[]);
  return res.rows;
}

export async function one<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Run a transaction with the tenant GUC set (enforces RLS on tenant tables). */
export async function withTenant<T>(salonId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return tx(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_salon_id', salonId]);
    return fn(client);
  });
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
