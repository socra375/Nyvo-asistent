import type { Deps, User } from '../deps.js';
import { LlmHttpError } from '../llm/types.js';
import { ENGINES, engineConfigured, engineOrder } from '../llm/build.js';
import {
  binary, clientIp, HttpError, isSameOriginWrite, isUuid, json, publicOrigin, readJson, redirect, SECURITY_HEADERS, str, type Req, type Res
} from './http.js';
import { createSession, destroySession, isAllowedEmail, sessionUser, upsertUser } from '../auth/session.js';
import { finishGoogleAuth, googleConfigured, saveGoogleTokens, startGoogleAuth } from '../auth/google.js';
import { verifyPassword, safeEqual } from '../crypto.js';
import { allowAttempt, audit, isBlocked } from '../audit.js';
import { connectorContext, connectorStatuses, getConnector, saveConnectorSettings } from '../../connectors/registry.js';
import { clientsPanel } from '../../connectors/ainova/index.js';
import { drivePanel } from '../../connectors/google-drive/index.js';
import { notionPanel } from '../../connectors/notion/index.js';
import { runTurn } from '../agents/main.js';
import { deleteConversation, listConversations, listMessages } from '../agents/conversations.js';
import { cancelCard, confirmCard, listCards, undoCard } from '../actions/actions.js';
import { cancelJob, listJobs, retryJob } from '../jobs/queue.js';
import { runTick } from '../jobs/tick.js';
import * as memory from '../memory/memory.js';
import { synthesize, voiceMissing, voiceProvider } from '../voice/tts.js';
import { serverVoices } from '../voice/voices.js';
import { sttMissing, sttProvider, transcribeAudio } from '../voice/stt.js';

interface Ctx { req: Req; res: Res; deps: Deps; params: Record<string, string>; url: URL; user: User }
type Handler = (c: Ctx) => Promise<void>;
type PublicHandler = (c: Omit<Ctx, 'user'>) => Promise<void>;

interface Route { method: string; re: RegExp; keys: string[]; auth: boolean; h: Handler | PublicHandler }
const routes: Route[] = [];

function add(method: string, pattern: string, auth: boolean, h: Handler | PublicHandler) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, auth, h });
}
const pub = (m: string, p: string, h: PublicHandler) => add(m, p, false, h);
const priv = (m: string, p: string, h: Handler) => add(m, p, true, h);

const secure = (deps: Deps, req: Req) => deps.cfg.production || String(req.headers['x-forwarded-proto'] ?? '').startsWith('https');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const uuidParam = (v: string | undefined) => { if (!v || !isUuid(v)) throw new HttpError(400, 'Id inválido.'); return v; };

// ───────────────────────── Sesión ─────────────────────────

pub('GET', '/api/health', async ({ res }) => json(res, 200, { ok: true, servicio: 'nyvo' }));

pub('GET', '/api/session', async ({ req, res, deps }) => {
  const user = await sessionUser(deps.db, req);
  json(res, 200, { user, googleLogin: googleConfigured(deps), ownerConfigured: deps.cfg.ownerEmails.length > 0 });
});

pub('POST', '/api/auth/login', async ({ req, res, deps }) => {
  const body = await readJson(req);
  const email = str(body.email, 200, 'correo').toLowerCase();
  const password = str(body.password, 200, 'contraseña');
  // Solo cuentan los intentos FALLIDOS: entrar bien nunca bloquea al dueño.
  const limitKey = `login:${clientIp(req)}`;
  if (await isBlocked(deps.db, limitKey, 10, 900)) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  const r = await deps.db.query<User & { password_hash: string | null }>('select id, email, name, password_hash from users where email = $1', [email]);
  const row = r.rows[0];
  const ok = isAllowedEmail(email, deps.cfg.ownerEmails) && await verifyPassword(password, row?.password_hash);
  await audit(deps.db, row?.id ?? null, 'login.correo', { ip: clientIp(req) }, ok);
  if (!ok || !row) {
    await allowAttempt(deps.db, limitKey, 10, 900);
    throw new HttpError(401, 'Correo o contraseña incorrectos.');
  }
  const cookie = await createSession(deps.db, row.id, secure(deps, req));
  json(res, 200, { user: { id: row.id, email: row.email, name: row.name } }, { 'Set-Cookie': cookie });
});

pub('POST', '/api/auth/logout', async ({ req, res, deps }) => {
  json(res, 200, { ok: true }, { 'Set-Cookie': await destroySession(deps.db, req, secure(deps, req)) });
});

pub('GET', '/api/auth/google/start', async ({ req, res, deps, url }) => {
  const purpose = url.searchParams.get('purpose') === 'connector' ? 'connector' : 'login';
  const origin = publicOrigin(req, deps.cfg.appUrl);
  if (purpose === 'login') return redirect(res, await startGoogleAuth(deps, { origin, purpose, userId: null, scopes: [] }));
  const user = await sessionUser(deps.db, req);
  if (!user) throw new HttpError(401, 'Inicia sesión primero.');
  const id = url.searchParams.get('connector') ?? '';
  const scopes = getConnector(id)?.google?.scopes;
  if (!scopes) throw new HttpError(400, 'Ese conector no usa Google.');
  redirect(res, await startGoogleAuth(deps, { origin, purpose, userId: user.id, connectorId: id, scopes }));
});

pub('GET', '/api/oauth/google/callback', async ({ req, res, deps, url }) => {
  const fail = (m: string) => redirect(res, `/?error=${encodeURIComponent(m)}`);
  if (url.searchParams.get('error')) return fail('Google canceló el permiso.');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return fail('Respuesta de Google incompleta.');
  try {
    const r = await finishGoogleAuth(deps, { origin: publicOrigin(req, deps.cfg.appUrl), code, state });
    if (r.purpose === 'login') {
      if (!isAllowedEmail(r.claims.email, deps.cfg.ownerEmails)) {
        await audit(deps.db, null, 'login.google', { motivo: 'correo no permitido' }, false);
        return fail('Esta cuenta de Google no tiene acceso a Nyvo.');
      }
      const user = await upsertUser(deps.db, r.claims.email, r.claims.name);
      await audit(deps.db, user.id, 'login.google');
      return redirect(res, '/', { 'Set-Cookie': await createSession(deps.db, user.id, secure(deps, req)) });
    }
    if (!r.userId) return fail('Sesión no válida.');
    await saveGoogleTokens(deps, r.userId, r.claims.email, r.tokens);
    await audit(deps.db, r.userId, 'google.conectado', { conector: r.connectorId });
    redirect(res, `/?conectado=${encodeURIComponent(r.connectorId ?? 'google')}`);
  } catch (e) {
    fail(e instanceof HttpError ? e.message : 'No se pudo completar el acceso con Google.');
  }
});

// ───────────────────────── Conectores y paneles ─────────────────────────

priv('GET', '/api/connectors', async ({ res, deps, user }) => json(res, 200, { connectors: await connectorStatuses(deps, user.id) }));

priv('PUT', '/api/connectors/:id', async ({ req, res, deps, user, params }) => {
  const c = getConnector(params.id!);
  if (!c) throw new HttpError(404, 'Conector desconocido.');
  const body = await readJson(req);
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
  let settings: Record<string, unknown> | undefined;
  if (body.settings && typeof body.settings === 'object') {
    const defaults = c.defaultSettings ?? {};
    settings = Object.fromEntries(Object.entries(body.settings as Record<string, unknown>)
      .filter(([k, v]) => k in defaults && typeof v === typeof defaults[k]));
  }
  await saveConnectorSettings(deps, user.id, c.id, enabled, settings);
  await audit(deps.db, user.id, 'conector.ajustes', { conector: c.id, enabled });
  json(res, 200, { connectors: await connectorStatuses(deps, user.id) });
});

async function panel(c: Ctx, id: string, load: (ctx: Awaited<ReturnType<typeof connectorContext>>['ctx']) => Promise<unknown>) {
  const { status, ctx } = await connectorContext(c.deps, c.user.id, id);
  if (status.state !== 'listo') return json(c.res, 200, { state: status.state, missingEnv: status.missingEnv, missingScopes: status.missingScopes });
  try {
    json(c.res, 200, { state: 'listo', data: await load(ctx) });
  } catch (e) {
    json(c.res, 200, { state: 'error', error: errMsg(e).slice(0, 300) });
  }
}

priv('GET', '/api/panels/clients', c => panel(c, 'ainova', ctx => clientsPanel(ctx, c.url.searchParams.get('q')?.slice(0, 200) || undefined)));
priv('GET', '/api/panels/drive', c => panel(c, 'google-drive', drivePanel));
priv('GET', '/api/panels/notion', c => panel(c, 'notion', notionPanel));

// ───────────────────────── Chat y tarjetas ─────────────────────────

priv('GET', '/api/conversations', async ({ res, deps, user }) => json(res, 200, { conversations: await listConversations(deps.db, user.id) }));

priv('GET', '/api/conversations/:id/messages', async ({ res, deps, user, params }) => {
  const id = uuidParam(params.id);
  const messages = await listMessages(deps.db, user.id, id);
  const cards = await listCards(deps, user.id, { ids: [...new Set(messages.flatMap(m => m.card_ids))] });
  json(res, 200, { messages, cards });
});

priv('DELETE', '/api/conversations/:id', async ({ res, deps, user, params }) => {
  if (!(await deleteConversation(deps.db, user.id, uuidParam(params.id)))) throw new HttpError(404, 'No existe.');
  json(res, 200, { ok: true });
});

priv('POST', '/api/chat', async ({ req, res, deps, user }) => {
  const body = await readJson(req);
  const message = str(body.message, 4000, 'mensaje');
  const conversationId = body.conversationId ? uuidParam(String(body.conversationId)) : null;
  const r = await runTurn(deps, { userId: user.id, conversationId, message, voice: body.voice === true });
  json(res, 200, { ...r, cards: await listCards(deps, user.id, { ids: r.cardIds }) });
});

/**
 * Igual que /api/chat, pero con progreso en vivo (NDJSON, una línea JSON por evento): el orbe sabe qué hemisferio
 * trabaja mientras llega la respuesta. Eventos: {tipo:'pensando'}, {tipo:'hemisferio', id, estado, herramienta},
 * y al final {tipo:'fin', …resultado, cards} o {tipo:'error', status, mensaje}.
 */
priv('POST', '/api/chat/stream', async ({ req, res, deps, user }) => {
  // Se valida todo ANTES de abrir el flujo: un error de petición sale como JSON normal con su código HTTP.
  const body = await readJson(req);
  const message = str(body.message, 4000, 'mensaje');
  const conversationId = body.conversationId ? uuidParam(String(body.conversationId)) : null;
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  const send = (o: unknown) => { res.write(`${JSON.stringify(o)}\n`); };
  try {
    const r = await runTurn(deps, { userId: user.id, conversationId, message, voice: body.voice === true, onEvent: send });
    send({ tipo: 'fin', ...r, cards: await listCards(deps, user.id, { ids: r.cardIds }) });
  } catch (e) {
    if (!(e instanceof HttpError) && !(e instanceof LlmHttpError)) console.error('chat/stream', e instanceof Error ? e.stack : e);
    const llmDown = e instanceof LlmHttpError;
    send({ tipo: 'error', status: e instanceof HttpError ? e.status : llmDown ? 503 : 500, mensaje: e instanceof HttpError || llmDown ? e.message : 'Error interno.' });
  }
  res.end();
});

priv('GET', '/api/actions', async ({ res, deps, user }) => json(res, 200, { cards: await listCards(deps, user.id) }));
priv('POST', '/api/actions/:id/confirm', async ({ res, deps, user, params }) => json(res, 200, { card: await confirmCard(deps, user.id, uuidParam(params.id)) }));
priv('POST', '/api/actions/:id/cancel', async ({ res, deps, user, params }) => json(res, 200, { card: await cancelCard(deps, user.id, uuidParam(params.id)) }));
priv('POST', '/api/actions/:id/undo', async ({ res, deps, user, params }) => json(res, 200, { card: await undoCard(deps, user.id, uuidParam(params.id)) }));

// ───────────────────────── Trabajos ─────────────────────────

priv('GET', '/api/jobs', async ({ res, deps, user }) => json(res, 200, { jobs: await listJobs(deps.db, user.id) }));
priv('POST', '/api/jobs/:id/retry', async ({ res, deps, user, params }) => {
  const job = await retryJob(deps.db, user.id, uuidParam(params.id));
  if (!job) throw new HttpError(409, 'Solo se reintentan trabajos fallidos o cancelados.');
  deps.defer(runTick(deps));
  json(res, 200, { job });
});
priv('POST', '/api/jobs/:id/cancel', async ({ res, deps, user, params }) => {
  const job = await cancelJob(deps.db, user.id, uuidParam(params.id));
  if (!job) throw new HttpError(409, 'Solo se cancelan trabajos en cola.');
  json(res, 200, { job });
});
priv('POST', '/api/jobs/run', async ({ res, deps }) => json(res, 200, await runTick(deps, 40_000)));

/** Disparador externo (GitHub Actions cada 10 min). Solo con Authorization: Bearer CRON_SECRET. */
const tick: PublicHandler = async ({ req, res, deps }) => {
  if (!deps.cfg.cronSecret) throw new HttpError(404, 'No encontrado.');
  const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
  if (!safeEqual(bearer, deps.cfg.cronSecret)) throw new HttpError(401, 'No autorizado.');
  json(res, 200, await runTick(deps));
};
pub('GET', '/api/jobs/tick', tick);
pub('POST', '/api/jobs/tick', tick);

// ───────────────────────── Memoria ─────────────────────────

priv('GET', '/api/memory', async ({ res, deps, user }) => json(res, 200, { notes: await memory.listNotes(deps.db, user.id), style: await memory.getStyle(deps.db, user.id) }));
priv('POST', '/api/memory', async ({ req, res, deps, user }) => {
  const body = await readJson(req);
  json(res, 201, { note: await memory.addNote(deps.db, user.id, str(body.content, 2000, 'nota'), body.tags) });
});
priv('DELETE', '/api/memory/:id', async ({ res, deps, user, params }) => {
  if (!(await memory.deleteNote(deps.db, user.id, uuidParam(params.id)))) throw new HttpError(404, 'No existe.');
  json(res, 200, { ok: true });
});
priv('DELETE', '/api/memory', async ({ res, deps, user }) => {
  await memory.deleteAllMemory(deps.db, user.id);
  await audit(deps.db, user.id, 'memoria.borrada');
  json(res, 200, { ok: true });
});
priv('GET', '/api/memory/export', async ({ res, deps, user }) => {
  json(res, 200, await memory.exportMemory(deps.db, user.id), { 'Content-Disposition': 'attachment; filename="nyvo-memoria.json"' });
});
priv('PUT', '/api/memory/style', async ({ req, res, deps, user }) => {
  const body = await readJson(req);
  json(res, 200, { style: await memory.setStyle(deps.db, user.id, str(body.description, 2000, 'descripción', false), body.samples) });
});

// ───────────────────────── Motores de IA ─────────────────────────

/** Qué motores hay, en qué orden se prueban y cuál está en enfriamiento (sin claves ni valores de las variables). */
priv('GET', '/api/llm/status', async ({ res, deps }) => {
  const env = deps.cfg.env;
  const order = engineOrder(env);
  json(res, 200, {
    rotation: order.filter(d => engineConfigured(env, d)).length > 1,
    order: order.map(d => d.name),
    engines: deps.llm?.status?.() ?? [],
    notConfigured: ENGINES.filter(d => !engineConfigured(env, d)).map(d => ({ name: d.name, missingEnv: [d.keyVar] }))
  });
});

// ───────────────────────── Voz ─────────────────────────

priv('GET', '/api/voice/config', async ({ res, deps }) => json(res, 200, {
  provider: voiceProvider(deps.cfg), missingEnv: voiceMissing(deps.cfg), maxChars: deps.cfg.limits.ttsMaxChars,
  voices: voiceMissing(deps.cfg).length ? [] : serverVoices(voiceProvider(deps.cfg), deps.cfg.env),
  stt: sttProvider(deps.cfg) === 'groq' ? !sttMissing(deps.cfg.env).length : Boolean(deps.llm), sttProvider: sttProvider(deps.cfg), sttMissing: sttProvider(deps.cfg) === 'groq' ? sttMissing(deps.cfg.env) : deps.llm ? [] : sttMissing(deps.cfg.env), wakeWord: 'Oye Nyvo'
}));

priv('POST', '/api/voice/tts', async ({ req, res, deps, user }) => {
  const body = await readJson(req, 50_000);
  if (!(await allowAttempt(deps.db, `tts:${user.id}`, 90, 60))) throw new HttpError(429, 'Demasiadas peticiones de voz. Espera un minuto.');
  const text = str(body.text, 20_000, 'texto');
  const voice = typeof body.voice === 'string' ? body.voice.slice(0, 60) : undefined;
  const speech = await synthesize(deps.cfg, deps.fetch, text, undefined, voice);
  binary(res, speech.mimeType, speech.audio);
});

const AUDIO_TYPES = /^audio\/(webm|ogg|wav|x-wav|mp4|mpeg|aac)(;.*)?$/;
priv('POST', '/api/voice/stt', async ({ req, res, deps, user }) => {
  const provider = sttProvider(deps.cfg);
  if (provider === 'groq' ? sttMissing(deps.cfg.env).length : !deps.llm) {
    throw new HttpError(503, `Falta configurar la transcripción de voz: ${(sttMissing(deps.cfg.env).length ? sttMissing(deps.cfg.env) : ['GROQ_API_KEY']).join(', ')}.`);
  }
  const body = await readJson(req, Math.ceil(deps.cfg.limits.sttMaxBytes * 1.4));
  const mime = str(body.mimeType, 100, 'tipo de audio');
  if (!AUDIO_TYPES.test(mime)) throw new HttpError(415, 'Formato de audio no admitido.');
  const audio = Buffer.from(str(body.audio, Math.ceil(deps.cfg.limits.sttMaxBytes * 1.4), 'audio'), 'base64');
  if (!audio.length || audio.length > deps.cfg.limits.sttMaxBytes) throw new HttpError(413, 'El audio está vacío o es demasiado largo.');
  if (!(await allowAttempt(deps.db, `stt:${user.id}`, 30, 60))) throw new HttpError(429, 'Demasiadas peticiones de voz. Espera un minuto.');
  const type = mime.split(';')[0]!;
  json(res, 200, { text: await transcribeAudio(deps.cfg, deps.fetch, deps.llm, audio, type) });
});

// ───────────────────────── Despachador ─────────────────────────

/** Enrutador único de la API (una sola función serverless en Vercel). */
export async function handle(req: Req, res: Res, deps: Deps | null): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    if (!deps) {
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, servicio: 'nyvo', db: false });
      return json(res, 503, { error: 'Falta configurar DATABASE_URL.', code: 'falta_configurar' });
    }
    let methodMismatch = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (r.method !== method) { methodMismatch = true; continue; }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      if (method !== 'GET' && !isSameOriginWrite(req)) throw new HttpError(403, 'Origen no permitido.');
      if (!r.auth) return await (r.h as PublicHandler)({ req, res, deps, params, url });
      const user = await sessionUser(deps.db, req);
      if (!user) throw new HttpError(401, 'Inicia sesión.');
      return await (r.h as Handler)({ req, res, deps, params, url, user });
    }
    throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Método no permitido.' : 'No encontrado.');
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, code: e.code });
    if (e instanceof LlmHttpError) return json(res, 503, { error: e.message, code: 'motor_ia' });   // todos los motores de IA fallaron
    console.error('api', e instanceof Error ? e.stack : e);
    json(res, 500, { error: 'Error interno.' });
  }
}
