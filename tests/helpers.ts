import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig, type Env } from '../server/config.js';
import { getDb, type Db } from '../server/db/pool.js';
import { migrate } from '../server/db/migrate.js';
import type { Deps } from '../server/deps.js';
import type { Llm, LlmRequest, LlmResponse } from '../server/llm/types.js';
import { createGemini } from '../server/llm/gemini.js';
import { handle } from '../server/http/routes.js';

export const TEST_DB = process.env.TEST_DATABASE_URL;
/** Las pruebas con base de datos necesitan TEST_DATABASE_URL (en CI la pone el servicio Postgres). */
export const needsDb = { skip: TEST_DB ? false : 'Falta TEST_DATABASE_URL' } as const;

export const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
export const OWNER = 'ianovasystem3@gmail.com';

/** Base de datos limpia con todas las migraciones. */
export async function freshDb(): Promise<Db> {
  const db = getDb(TEST_DB!);
  await db.query('drop schema if exists public cascade; create schema public;');
  await migrate(db);
  return db;
}

export function makeDeps(db: Db, env: Env = {}, opts: { llm?: Llm | null; fetch?: typeof fetch } = {}): Deps {
  const full: Env = { NYVO_OWNER_EMAIL: OWNER, NYVO_ENC_KEY: ENC_KEY, DATABASE_URL: TEST_DB, ...env };
  const cfg = loadConfig(full);
  const f = opts.fetch ?? fetch;
  const llm = opts.llm !== undefined ? opts.llm
    : full.GEMINI_API_KEY && full.GEMINI_MODEL ? createGemini({ apiKey: full.GEMINI_API_KEY, model: full.GEMINI_MODEL, baseUrl: cfg.urls.gemini, fetch: f }) : null;
  return { cfg, db, fetch: f, llm, defer: p => { void p.catch(() => undefined); } };
}

export async function makeUser(db: Db, email = OWNER): Promise<string> {
  return (await db.query<{ id: string }>('insert into users (email) values ($1) on conflict (email) do update set email = excluded.email returning id', [email])).rows[0]!.id;
}

/** LLM guionizado: cada llamada recibe la petición y devuelve la respuesta. */
export function scriptedLlm(fn: (req: LlmRequest, i: number) => Partial<LlmResponse> | Promise<Partial<LlmResponse>>): Llm & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async generate(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r = await fn(req, requests.length - 1);
      const calls = r.calls ?? [];
      const text = r.text ?? '';
      return { text, calls, parts: r.parts ?? [...(text ? [{ text }] : []), ...calls.map(c => ({ functionCall: c }))] };
    },
    async transcribe() { return 'transcripción'; }
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON de prueba
export interface FakeResponse { status: number; headers: Record<string, string | string[]>; body: string; raw: Buffer; json: () => any }

/** Llama al enrutador real con una petición simulada (sin abrir puertos). */
export async function call(deps: Deps | null, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; cookie?: string } = {}): Promise<FakeResponse> {
  const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  Object.assign(req, {
    method, url: path,
    headers: { host: 'nyvo.test', ...(payload ? { 'content-type': 'application/json' } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
    socket: { remoteAddress: '127.0.0.1' }
  });
  const chunks: Buffer[] = [];
  let status = 200;
  let headers: Record<string, string | string[]> = {};
  const fake = {
    headersSent: false,
    writeHead(s: number, h: Record<string, string>) { status = s; headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v])); fake.headersSent = true; return fake; },
    end(b?: string | Buffer) { if (b) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); },
    on() { return fake; }
  };
  const res = fake as unknown as ServerResponse;
  await handle(req as never, res, deps);
  const raw = Buffer.concat(chunks);
  const text = raw.toString('utf8');
  return { status, headers, body: text, raw, json: () => JSON.parse(text) };
}

export const cookieFrom = (r: FakeResponse) => String(r.headers['set-cookie'] ?? '').split(';')[0]!;

/** Crea una sesión para el dueño y devuelve la cookie. */
export async function loginCookie(deps: Deps, email = OWNER): Promise<{ cookie: string; userId: string }> {
  const { createSession } = await import('../server/auth/session.js');
  const userId = await makeUser(deps.db, email);
  return { cookie: (await createSession(deps.db, userId, false)).split(';')[0]!, userId };
}
