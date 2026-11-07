/**
 * Servidor para las pruebas en Chromium: base de datos limpia, dueño con contraseña y,
 * salvo con --bare, servicios externos falsos (AINova MCP, Notion, Google, Gemini).
 * --bare arranca sin conectores para comprobar los estados «falta configurar».
 */
import pg from 'pg';
import { startUpstream, upstreamEnv } from '../fakes/upstream.js';

export const E2E_OWNER = 'ianovasystem3@gmail.com';
export const E2E_PASSWORD = 'clave-e2e-segura-123';

const bare = process.argv.includes('--bare');
const base = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!base) { console.error('Falta E2E_DATABASE_URL o TEST_DATABASE_URL.'); process.exit(1); }

// Cada servidor usa su propia base de datos (se crea si no existe) y la deja limpia.
const dbName = bare ? 'nyvo_e2e_bare' : 'nyvo_e2e';
const admin = new pg.Client({ connectionString: base });
await admin.connect();
const exists = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
if (!exists.rowCount) await admin.query(`create database ${dbName}`);
await admin.end();
const url = new URL(base);
url.pathname = `/${dbName}`;

const env: Record<string, string> = {
  DATABASE_URL: url.toString(),
  NYVO_OWNER_EMAIL: E2E_OWNER,
  NYVO_ENC_KEY: Buffer.alloc(32, 9).toString('base64'),
  PORT: bare ? '3101' : '3100',
  STATIC_DIR: 'dist',
  CRON_SECRET: 'cron-e2e-secreto'
};
if (!bare) {
  const up = await startUpstream(Number(process.env.UPSTREAM_PORT ?? 4110));
  Object.assign(env, upstreamEnv(up.url, up.state));
}
// La voz falsa dura lo bastante para que la interrupción (barge-in) caiga mientras «habla».
process.env.FAKE_TTS_SECONDS ??= '10';
Object.assign(process.env, env);

const { getDb } = await import('../../server/db/pool.js');
const { migrate } = await import('../../server/db/migrate.js');
const { hashPassword } = await import('../../server/crypto.js');
const db = getDb(env.DATABASE_URL!);
await db.query('drop schema if exists public cascade; create schema public;');
await migrate(db);
await db.query('insert into users (email, password_hash) values ($1, $2)', [E2E_OWNER, await hashPassword(E2E_PASSWORD)]);

await import('../../server/dev.js');
