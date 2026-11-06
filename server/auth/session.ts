import { randomToken, sha256 } from '../crypto.js';
import type { Db } from '../db/pool.js';
import type { User } from '../deps.js';
import { cookies, setCookie, type Req } from '../http/http.js';

export const SESSION_COOKIE = 'nyvo_session';
export const SESSION_DAYS = 14;

/** Crea una sesión: en la cookie va un token aleatorio; en la base de datos solo su hash. */
export async function createSession(db: Db, userId: string, secure: boolean): Promise<string> {
  const token = randomToken();
  await db.query(
    `insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
    [userId, sha256(token), SESSION_DAYS]);
  return setCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, secure });
}

export async function sessionUser(db: Db, req: Req): Promise<User | null> {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const r = await db.query<User>(
    `select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
  return r.rows[0] ?? null;
}

export async function destroySession(db: Db, req: Req, secure: boolean): Promise<string> {
  const token = cookies(req)[SESSION_COOKIE];
  if (token) await db.query('delete from sessions where token_hash = $1', [sha256(token)]);
  return setCookie(SESSION_COOKIE, '', { maxAge: 0, secure });
}

/** Solo los correos de NYVO_OWNER_EMAIL pueden entrar. */
export function isAllowedEmail(email: string, allowed: string[]): boolean {
  return allowed.length > 0 && allowed.includes(email.trim().toLowerCase());
}

export async function upsertUser(db: Db, email: string, name: string | null): Promise<User> {
  const r = await db.query<User>(
    `insert into users (email, name) values ($1, $2)
     on conflict (email) do update set name = coalesce(users.name, excluded.name)
     returning id, email, name`, [email.toLowerCase(), name]);
  return r.rows[0]!;
}
