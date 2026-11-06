import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getDb, closeAllDbs } from '../db/pool.js';
import { hashPassword } from '../crypto.js';
import { loadConfig } from '../config.js';

/**
 * Define (o cambia) la contraseña del dueño para entrar con correo.
 * Uso: DATABASE_URL=... NYVO_OWNER_EMAIL=... npm run owner:password
 * La contraseña se escribe en la terminal (o por stdin) y nunca se guarda en claro.
 */
const cfg = loadConfig();
const email = cfg.ownerEmails[0];
if (!cfg.databaseUrl || !email) {
  console.error('Faltan DATABASE_URL o NYVO_OWNER_EMAIL.');
  process.exit(1);
}
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
const pw = (await rl.question(`Nueva contraseña para ${email} (mín. 12 caracteres): `)).trim();
rl.close();
if (pw.length < 12) {
  console.error('La contraseña debe tener al menos 12 caracteres.');
  process.exit(1);
}
const db = getDb(cfg.databaseUrl);
await db.query(
  `insert into users (email, password_hash) values ($1, $2) on conflict (email) do update set password_hash = excluded.password_hash`,
  [email, await hashPassword(pw)]);
console.log('Contraseña guardada.');
await closeAllDbs();
