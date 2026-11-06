import type { IncomingMessage, ServerResponse } from 'node:http';

export type Req = IncomingMessage & { body?: unknown };
export type Res = ServerResponse;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

/** Cabeceras de seguridad para todas las respuestas de la API. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

function base(res: Res, status: number, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
}

export function json(res: Res, status: number, data: unknown, extra: Record<string, string> = {}): void {
  base(res, status, 'application/json; charset=utf-8', extra);
  res.end(JSON.stringify(data));
}

export function binary(res: Res, type: string, data: Buffer): void {
  base(res, 200, type, { 'Content-Length': String(data.length) });
  res.end(data);
}

export function redirect(res: Res, location: string, extra: Record<string, string> = {}): void {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store', ...extra });
  res.end();
}

/** Lee el cuerpo JSON. En Vercel ya viene en req.body; en local se lee del flujo. */
export async function readJson(req: Req, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return parseObj(req.body);
    if (Buffer.isBuffer(req.body)) return parseObj(req.body.toString('utf8'));
    if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>;
    return {};
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'La petición es demasiado grande.');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  req.body = raw ? parseObj(raw) : {};
  return req.body as Record<string, unknown>;
}

function parseObj(s: string): Record<string, unknown> {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* cae al error */ }
  throw new HttpError(400, 'JSON inválido.');
}

export function cookies(req: Req): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(name: string, value: string, opts: { maxAge: number; secure: boolean; path?: string }): string {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, `Max-Age=${opts.maxAge}`, 'HttpOnly', 'SameSite=Lax', opts.secure ? 'Secure' : '']
    .filter(Boolean).join('; ');
}

/**
 * Escrituras solo desde el mismo origen (defensa CSRF junto con SameSite=Lax).
 * Peticiones sin Origin (servidor a servidor, p. ej. cron) se aceptan: no llevan la cookie del navegador.
 */
export function isSameOriginWrite(req: Req): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
  try { return new URL(origin).host === host; } catch { return false; }
}

export function clientIp(req: Req): string {
  return String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || req.socket?.remoteAddress || 'desconocida';
}

/** Origen público de la app (para URLs de retorno de OAuth). */
export function publicOrigin(req: Req, appUrl: string | undefined): string {
  if (appUrl) return appUrl;
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
}

export const str = (v: unknown, max: number, field: string, required = true): string => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `Falta el campo «${field}».`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `El campo «${field}» debe ser texto.`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `El campo «${field}» supera ${max} caracteres.`);
  if (required && !t) throw new HttpError(400, `Falta el campo «${field}».`);
  return t;
};

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
