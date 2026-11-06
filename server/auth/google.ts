import { createHash } from 'node:crypto';
import { decrypt, encrypt, parseKey, randomToken, sha256 } from '../crypto.js';
import type { Deps } from '../deps.js';
import { HttpError } from '../http/http.js';
import { missingEnv } from '../config.js';

/** Permisos mínimos para iniciar sesión. Los de cada conector se piden aparte, cuando se conecta. */
export const LOGIN_SCOPES = ['openid', 'email', 'profile'];
export const GOOGLE_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NYVO_ENC_KEY'] as const;

export const googleConfigured = (deps: Deps) => missingEnv(deps.cfg.env, GOOGLE_ENV).length === 0;

function key(deps: Deps): Buffer {
  const k = parseKey(deps.cfg.env.NYVO_ENC_KEY);
  if (!k) throw new HttpError(503, 'Falta configurar NYVO_ENC_KEY (32 bytes en base64 o hex).');
  return k;
}

export const callbackUrl = (origin: string) => `${origin}/api/oauth/google/callback`;

/** Construye la URL de consentimiento con PKCE y un estado de un solo uso (10 min). */
export async function startGoogleAuth(deps: Deps, opts: { origin: string; purpose: 'login' | 'connector'; userId: string | null; connectorId?: string; scopes: string[] }): Promise<string> {
  if (!googleConfigured(deps)) throw new HttpError(503, 'Falta configurar Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, NYVO_ENC_KEY).');
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await deps.db.query(
    `insert into oauth_states (state_hash, user_id, purpose, connector_id, verifier_enc, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
    [sha256(state), opts.userId, opts.purpose, opts.connectorId ?? null, encrypt(verifier, key(deps))]);
  const p = new URLSearchParams({
    client_id: deps.cfg.env.GOOGLE_CLIENT_ID!,
    redirect_uri: callbackUrl(opts.origin),
    response_type: 'code',
    scope: [...new Set([...LOGIN_SCOPES, ...opts.scopes])].join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    include_granted_scopes: 'true'
  });
  if (opts.purpose === 'connector') { p.set('access_type', 'offline'); p.set('prompt', 'consent'); }
  else p.set('prompt', 'select_account');
  return `${deps.cfg.urls.googleAuth}?${p}`;
}

export interface IdClaims { email: string; name: string | null }

/** Valida las afirmaciones del id_token recibido directamente del endpoint de tokens de Google por TLS (OIDC Core 3.1.3.7). */
export function checkIdToken(idToken: string, clientId: string, nowSec = Math.floor(Date.now() / 1000)): IdClaims {
  const payload = idToken.split('.')[1];
  if (!payload) throw new HttpError(401, 'Respuesta de Google inválida.');
  let c: Record<string, unknown>;
  try { c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { throw new HttpError(401, 'Respuesta de Google inválida.'); }
  if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') throw new HttpError(401, 'Emisor no válido.');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new HttpError(401, 'El token no es para esta aplicación.');
  if (typeof c.exp !== 'number' || c.exp < nowSec) throw new HttpError(401, 'El token de Google caducó.');
  if (c.email_verified !== true || typeof c.email !== 'string') throw new HttpError(401, 'El correo de Google no está verificado.');
  return { email: c.email.toLowerCase(), name: typeof c.name === 'string' ? c.name : null };
}

export interface CallbackResult {
  purpose: 'login' | 'connector';
  userId: string | null;
  connectorId: string | null;
  claims: IdClaims;
  tokens: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
}

export async function finishGoogleAuth(deps: Deps, opts: { origin: string; code: string; state: string }): Promise<CallbackResult> {
  const r = await deps.db.query<{ user_id: string | null; purpose: 'login' | 'connector'; connector_id: string | null; verifier_enc: string }>(
    `delete from oauth_states where state_hash = $1 and expires_at > now() returning user_id, purpose, connector_id, verifier_enc`,
    [sha256(opts.state)]);
  const st = r.rows[0];
  if (!st) throw new HttpError(400, 'El enlace de Google caducó o ya se usó. Inténtalo de nuevo.');
  const body = new URLSearchParams({
    code: opts.code,
    client_id: deps.cfg.env.GOOGLE_CLIENT_ID!,
    client_secret: deps.cfg.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: callbackUrl(opts.origin),
    grant_type: 'authorization_code',
    code_verifier: decrypt(st.verifier_enc, key(deps))
  });
  const resp = await deps.fetch(deps.cfg.urls.googleToken, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!resp.ok) throw new HttpError(502, 'Google rechazó el intercambio del código.');
  const tokens = await resp.json() as CallbackResult['tokens'] & { id_token?: string };
  if (!tokens.id_token || !tokens.access_token) throw new HttpError(502, 'Google no devolvió los tokens esperados.');
  return { purpose: st.purpose, userId: st.user_id, connectorId: st.connector_id, claims: checkIdToken(tokens.id_token, deps.cfg.env.GOOGLE_CLIENT_ID!), tokens };
}

/** Guarda (cifrados) los tokens del usuario y suma los permisos concedidos. */
export async function saveGoogleTokens(deps: Deps, userId: string, email: string, t: CallbackResult['tokens']): Promise<void> {
  const k = key(deps);
  const scopes = (t.scope ?? '').split(' ').filter(Boolean);
  await deps.db.query(
    `insert into oauth_accounts (user_id, provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at, updated_at)
     values ($1, 'google', $2, $3, $4, $5, now() + make_interval(secs => $6), now())
     on conflict (user_id, provider) do update set
       account_email = excluded.account_email,
       scopes = (select array(select distinct unnest(oauth_accounts.scopes || excluded.scopes))),
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = coalesce(excluded.refresh_token_enc, oauth_accounts.refresh_token_enc),
       expires_at = excluded.expires_at, updated_at = now()`,
    [userId, email, scopes, encrypt(t.access_token, k), t.refresh_token ? encrypt(t.refresh_token, k) : null, t.expires_in ?? 3000]);
}

export async function googleScopes(deps: Deps, userId: string): Promise<string[]> {
  const r = await deps.db.query<{ scopes: string[] }>(`select scopes from oauth_accounts where user_id = $1 and provider = 'google'`, [userId]);
  return r.rows[0]?.scopes ?? [];
}

/** Devuelve un access token vigente; lo renueva con el refresh token si caducó. */
export async function googleAccessToken(deps: Deps, userId: string): Promise<string> {
  const r = await deps.db.query<{ access_token_enc: string | null; refresh_token_enc: string | null; expired: boolean }>(
    `select access_token_enc, refresh_token_enc, (expires_at is null or expires_at < now() + interval '60 seconds') as expired
     from oauth_accounts where user_id = $1 and provider = 'google'`, [userId]);
  const row = r.rows[0];
  if (!row?.access_token_enc) throw new HttpError(409, 'Google no está conectado.');
  const k = key(deps);
  if (!row.expired) return decrypt(row.access_token_enc, k);
  if (!row.refresh_token_enc) throw new HttpError(409, 'El permiso de Google caducó. Vuelve a conectar Google.');
  const resp = await deps.fetch(deps.cfg.urls.googleToken, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: deps.cfg.env.GOOGLE_CLIENT_ID!, client_secret: deps.cfg.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: decrypt(row.refresh_token_enc, k), grant_type: 'refresh_token'
    })
  });
  if (!resp.ok) throw new HttpError(409, 'Google revocó el permiso. Vuelve a conectar Google.');
  const t = await resp.json() as { access_token: string; expires_in?: number };
  await deps.db.query(
    `update oauth_accounts set access_token_enc = $2, expires_at = now() + make_interval(secs => $3), updated_at = now() where user_id = $1 and provider = 'google'`,
    [userId, encrypt(t.access_token, k), t.expires_in ?? 3000]);
  return t.access_token;
}
