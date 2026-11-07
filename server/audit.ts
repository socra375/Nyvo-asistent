import type { Db } from './db/pool.js';

/** Registro de auditoría. Nunca guarda textos largos ni secretos: solo nombres, ids y tamaños. */
export async function audit(db: Db, userId: string | null, action: string, detail: Record<string, unknown> = {}, ok = true): Promise<void> {
  const safe = Object.fromEntries(Object.entries(detail).map(([k, v]) =>
    [k, typeof v === 'string' && v.length > 120 ? `[${v.length} caracteres]` : v]));
  await db.query('insert into audit_log (user_id, action, detail, ok) values ($1, $2, $3, $4)', [userId, action, safe, ok]);
}

/** ¿La clave ya superó el máximo en la ventana actual? (no suma un intento). */
export async function isBlocked(db: Db, key: string, max: number, windowSec: number): Promise<boolean> {
  const r = await db.query<{ count: number }>(
    `select count from rate_limits where key = $1 and window_start >= now() - make_interval(secs => $2)`, [key, windowSec]);
  return (r.rows[0]?.count ?? 0) >= max;
}

/** Límite de intentos por ventana (compartido entre instancias vía Postgres). Suma un intento. */
export async function allowAttempt(db: Db, key: string, max: number, windowSec: number): Promise<boolean> {
  const r = await db.query<{ count: number }>(
    `insert into rate_limits (key, count, window_start) values ($1, 1, now())
     on conflict (key) do update set
       count = case when rate_limits.window_start < now() - make_interval(secs => $2) then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start < now() - make_interval(secs => $2) then now() else rate_limits.window_start end
     returning count`, [key, windowSec]);
  return (r.rows[0]?.count ?? 0) <= max;
}
