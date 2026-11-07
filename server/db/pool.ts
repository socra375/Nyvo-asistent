import pg from 'pg';

/** Lo mínimo que necesita el código: consultas parametrizadas y transacciones. */
export interface Db {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

const pools = new Map<string, pg.Pool>();

function wrap(q: pg.Pool | pg.PoolClient, pool?: pg.Pool): Db {
  return {
    query: (sql, params) => q.query(sql, params as unknown[]),
    async tx(fn) {
      if (!pool) return fn(this); // ya dentro de una transacción
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    }
  };
}

/** Pool reutilizado entre invocaciones de la misma instancia serverless. */
export function getDb(url: string): Db {
  let pool = pools.get(url);
  if (!pool) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    pool = new pg.Pool({ connectionString: url, max: 3, ssl: local ? undefined : { rejectUnauthorized: true } });
    pools.set(url, pool);
  }
  return wrap(pool, pool);
}

export async function closeAllDbs(): Promise<void> {
  await Promise.all([...pools.values()].map(p => p.end()));
  pools.clear();
}
