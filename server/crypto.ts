import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

/** NYVO_ENC_KEY: 32 bytes en base64 o 64 caracteres hex. */
export function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return k.length === 32 ? k : null;
}

/** AES-256-GCM. Formato: v1.<iv>.<tag>.<cifrado> en base64url. */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(box: string, key: Buffer): string {
  const [v, iv, tag, ct] = box.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Formato cifrado inválido');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

const N = 16384;
const SEP = '$';

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, 32, { N, r: 8, p: 1 });
  return ['scrypt', String(N), salt.toString('base64url'), h.toString('base64url')].join(SEP);
}

export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? '').split(SEP);
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[2]!, 'base64url');
  const expected = Buffer.from(parts[3]!, 'base64url');
  const h = await scrypt(pw, salt, expected.length, { N: Number(parts[1]), r: 8, p: 1 });
  return h.length === expected.length && timingSafeEqual(h, expected);
}

/** Comparación en tiempo constante de dos secretos (p. ej. CRON_SECRET). */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
