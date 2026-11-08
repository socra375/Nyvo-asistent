import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeAllDbs, type Db } from '../../server/db/pool.js';
import { hashPassword } from '../../server/crypto.js';
import { googleAccessToken } from '../../server/auth/google.js';
import { call, cookieFrom, freshDb, loginCookie, makeDeps, needsDb, OWNER } from '../helpers.js';
import { startUpstream, upstreamEnv, type Upstream } from '../fakes/upstream.js';

describe('API HTTP', needsDb, () => {
  let db: Db;
  let up: Upstream;
  let env: Record<string, string>;
  before(async () => { db = await freshDb(); up = await startUpstream(); env = upstreamEnv(up.url, up.state); });
  after(async () => { await up.close(); await closeAllDbs(); });

  test('sin DATABASE_URL: health responde y el resto dice «falta configurar»', async () => {
    assert.equal((await call(null, 'GET', '/api/health')).json().db, false);
    const r = await call(null, 'GET', '/api/connectors');
    assert.equal(r.status, 503);
    assert.equal(r.json().code, 'falta_configurar');
  });

  test('rutas privadas exigen sesión; cabeceras de seguridad presentes', async () => {
    const r = await call(makeDeps(db), 'GET', '/api/connectors');
    assert.equal(r.status, 401);
    assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal((await call(makeDeps(db), 'GET', '/api/nada')).status, 404);
    assert.equal((await call(makeDeps(db), 'PATCH', '/api/connectors')).status, 405);
  });

  test('login con correo: solo el dueño, contraseña correcta, cookie HttpOnly', async () => {
    const deps = makeDeps(db);
    await db.query('insert into users (email, password_hash) values ($1, $2)', [OWNER, await hashPassword('clave-de-prueba-123')]);
    await db.query('insert into users (email, password_hash) values ($1, $2)', ['otro@x.com', await hashPassword('clave-de-prueba-123')]);
    assert.equal((await call(deps, 'POST', '/api/auth/login', { body: { email: OWNER, password: 'mala' } })).status, 401);
    assert.equal((await call(deps, 'POST', '/api/auth/login', { body: { email: 'otro@x.com', password: 'clave-de-prueba-123' } })).status, 401, 'correo no permitido');
    const ok = await call(deps, 'POST', '/api/auth/login', { body: { email: OWNER.toUpperCase(), password: 'clave-de-prueba-123' } });
    assert.equal(ok.status, 200);
    assert.match(String(ok.headers['set-cookie']), /HttpOnly; SameSite=Lax/);
    const s = await call(deps, 'GET', '/api/session', { cookie: cookieFrom(ok) });
    assert.equal(s.json().user.email, OWNER);
    const out = await call(deps, 'POST', '/api/auth/logout', { cookie: cookieFrom(ok) });
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await call(deps, 'GET', '/api/session', { cookie: cookieFrom(ok) })).json().user, null);
    const audit = (await db.query(`select count(*)::int as n from audit_log where action = 'login.correo' and ok = false`)).rows[0]!.n;
    assert.equal(audit, 2);
  });

  test('límite de intentos de login', async () => {
    const deps = makeDeps(db);
    // Entrar bien no consume intentos.
    const okHeaders = { 'x-forwarded-for': '10.0.0.8' };
    for (let i = 0; i < 12; i++) {
      assert.equal((await call(deps, 'POST', '/api/auth/login', { body: { email: OWNER, password: 'clave-de-prueba-123' }, headers: okHeaders })).status, 200);
    }
    const headers = { 'x-forwarded-for': '10.0.0.9' };
    for (let i = 0; i < 10; i++) await call(deps, 'POST', '/api/auth/login', { body: { email: 'a@b.c', password: 'x' }, headers });
    assert.equal((await call(deps, 'POST', '/api/auth/login', { body: { email: 'a@b.c', password: 'x' }, headers })).status, 429);
  });

  test('CSRF: una escritura desde otro origen se rechaza', async () => {
    const deps = makeDeps(db);
    const { cookie } = await loginCookie(deps);
    const r = await call(deps, 'POST', '/api/memory', { cookie, body: { content: 'x' }, headers: { origin: 'https://malo.test' } });
    assert.equal(r.status, 403);
  });

  test('Google: login con PKCE, solo el correo de la empresa', async () => {
    const deps = makeDeps(db, env);
    const start = await call(deps, 'GET', '/api/auth/google/start?purpose=login');
    assert.equal(start.status, 302);
    const loc = new URL(String(start.headers.location));
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(loc.searchParams.get('scope'), 'openid email profile');
    assert.equal(loc.searchParams.get('redirect_uri'), 'http://nyvo.test/api/oauth/google/callback');
    const cb = await call(deps, 'GET', `/api/oauth/google/callback?code=code-login&state=${loc.searchParams.get('state')}`);
    assert.equal(cb.headers.location, '/');
    assert.match(String(cb.headers['set-cookie']), /nyvo_session=/);
    // El estado es de un solo uso.
    const again = await call(deps, 'GET', `/api/oauth/google/callback?code=code-login&state=${loc.searchParams.get('state')}`);
    assert.match(String(again.headers.location), /error=/);
    // Otra cuenta de Google no entra.
    up.state.googleEmail = 'intruso@gmail.com';
    const s2 = new URL(String((await call(deps, 'GET', '/api/auth/google/start?purpose=login')).headers.location));
    const cb2 = await call(deps, 'GET', `/api/oauth/google/callback?code=code-login&state=${s2.searchParams.get('state')}`);
    assert.match(decodeURIComponent(String(cb2.headers.location)), /no tiene acceso/);
    up.state.googleEmail = OWNER;
  });

  test('Google: conectar Drive pide solo su permiso y guarda tokens cifrados; el panel lista archivos', async () => {
    const deps = makeDeps(db, env);
    const { cookie, userId } = await loginCookie(deps);
    assert.equal((await call(deps, 'GET', '/api/panels/drive', { cookie })).json().state, 'falta_conectar');
    const start = await call(deps, 'GET', '/api/auth/google/start?purpose=connector&connector=google-drive', { cookie });
    const loc = new URL(String(start.headers.location));
    assert.match(loc.searchParams.get('scope')!, /drive\.metadata\.readonly/);
    assert.doesNotMatch(loc.searchParams.get('scope')!, /gmail|calendar/);
    assert.equal(loc.searchParams.get('access_type'), 'offline');
    const cb = await call(deps, 'GET', `/api/oauth/google/callback?code=code-drive&state=${loc.searchParams.get('state')}`);
    assert.equal(cb.headers.location, '/?conectado=google-drive');
    const row = (await db.query(`select access_token_enc, refresh_token_enc from oauth_accounts where user_id = $1`, [userId])).rows[0]!;
    assert.doesNotMatch(row.access_token_enc, /access-falso/);
    assert.match(row.refresh_token_enc, /^v1\./);
    const panel = (await call(deps, 'GET', '/api/panels/drive', { cookie })).json();
    assert.equal(panel.state, 'listo');
    assert.deepEqual(panel.data.map((f: { title: string }) => f.title), ['Plan comercial 2026', 'Cobros noviembre']);
    // Token caducado: se renueva con el refresh token.
    await db.query(`update oauth_accounts set expires_at = now() - interval '1 hour' where user_id = $1`, [userId]);
    assert.equal(await googleAccessToken(deps, userId), 'access-renovado');
  });

  test('conectores: lista y ajustes (solo claves conocidas)', async () => {
    const deps = makeDeps(db, env);
    const { cookie } = await loginCookie(deps);
    const r = await call(deps, 'PUT', '/api/connectors/notion', { cookie, body: { enabled: false, settings: { autoGuardar: false, inventado: 1 } } });
    const notion = r.json().connectors.find((c: { id: string }) => c.id === 'notion');
    assert.equal(notion.state, 'desactivado');
    assert.deepEqual(notion.settings, { autoGuardar: false });
    await call(deps, 'PUT', '/api/connectors/notion', { cookie, body: { enabled: true, settings: { autoGuardar: true } } });
    assert.equal((await call(deps, 'GET', '/api/panels/notion', { cookie })).json().state, 'listo');
    assert.equal((await call(deps, 'GET', '/api/panels/clients', { cookie })).json().data.clients.length, 2);
  });

  test('memoria: crear, listar, exportar, borrar una y borrar todo', async () => {
    const deps = makeDeps(db);
    const { cookie } = await loginCookie(deps);
    const n = (await call(deps, 'POST', '/api/memory', { cookie, body: { content: 'Prefiero correos breves', tags: ['Estilo'] } })).json().note;
    assert.deepEqual(n.tags, ['estilo']);
    await call(deps, 'PUT', '/api/memory/style', { cookie, body: { description: 'Directo y cordial', samples: ['Hola, te escribo para…'] } });
    const exp = await call(deps, 'GET', '/api/memory/export', { cookie });
    assert.match(String(exp.headers['content-disposition']), /nyvo-memoria\.json/);
    assert.equal(exp.json().notas.length, 1);
    assert.equal(exp.json().estilo.description, 'Directo y cordial');
    assert.equal((await call(deps, 'DELETE', `/api/memory/${n.id}`, { cookie })).status, 200);
    await call(deps, 'POST', '/api/memory', { cookie, body: { content: 'otra' } });
    await call(deps, 'DELETE', '/api/memory', { cookie });
    const m = (await call(deps, 'GET', '/api/memory', { cookie })).json();
    assert.equal(m.notes.length, 0);
    assert.equal(m.style.description, '');
  });

  test('voz: Gemini TTS con voz predefinida y AUDIO, límite de caracteres, ElevenLabs y transcripción', async () => {
    const deps = makeDeps(db, env);
    const { cookie } = await loginCookie(deps);
    const r = await call(deps, 'POST', '/api/voice/tts', { cookie, body: { text: 'Hola, soy Nyvo.' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'audio/wav');
    assert.equal(r.raw.subarray(0, 4).toString(), 'RIFF');
    const req = up.state.geminiRequests.at(-1)!;
    assert.equal(req.model, 'tts-falso');
    assert.deepEqual((req.body.generationConfig as Record<string, unknown>).responseModalities, ['AUDIO']);
    assert.equal(JSON.stringify(req.body).includes('"voiceName":"VozFalsa"'), true);
    assert.equal((await call(deps, 'POST', '/api/voice/tts', { cookie, body: { text: 'a'.repeat(1501) } })).status, 413);
    const eleven = makeDeps(db, { ...env, VOICE_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' });
    const e = await call(eleven, 'POST', '/api/voice/tts', { cookie, body: { text: 'Hola' } });
    assert.equal(e.headers['content-type'], 'audio/mpeg');
    const speechify = makeDeps(db, { ...env, VOICE_PROVIDER: 'speechify', SPEECHIFY_API_KEY: 'speechify-falso', SPEECHIFY_VOICE_ID: 'voz-1' });
    const sp = await call(speechify, 'POST', '/api/voice/tts', { cookie, body: { text: 'Hola, soy Nyvo.' } });
    assert.equal(sp.status, 200);
    assert.equal(sp.headers['content-type'], 'audio/mpeg');
    assert.deepEqual([...sp.raw], [0xff, 0xfb, 0x90, 0x00], 'se decodifica el audio base64');
    const spBad = makeDeps(db, { ...env, VOICE_PROVIDER: 'speechify', SPEECHIFY_API_KEY: 'clave-mala', SPEECHIFY_VOICE_ID: 'voz-1' });
    assert.equal((await call(spBad, 'POST', '/api/voice/tts', { cookie, body: { text: 'Hola' } })).status, 502, 'clave rechazada → error de pasarela, sin filtrar la clave');
    // Texto con marcas, «&» o caracteres de control: se limpia antes de enviarlo (el proveedor lo rechazaría con 400)
    assert.equal((await call(speechify, 'POST', '/api/voice/tts', { cookie, body: { text: 'Cobros <b>pendientes</b> & vencidos\u0007 hoy' } })).status, 200);
    // Solo signos: no se llama al proveedor, 400 claro
    assert.equal((await call(speechify, 'POST', '/api/voice/tts', { cookie, body: { text: '… ¿? !' } })).status, 400);
    // Un 400 del proveedor llega con su motivo (sin él no se puede diagnosticar)
    const rej = await call(speechify, 'POST', '/api/voice/tts', { cookie, body: { text: 'Esto debe RECHAZAR el proveedor' } });
    assert.equal(rej.status, 502);
    assert.match(rej.json().error, /Speechify respondió 400: .*texto rechazado por el proveedor/);
    assert.ok(!rej.body.includes('speechify-falso'), 'sin la clave en el mensaje');
    const noVoice = makeDeps(db, { ...env, GEMINI_TTS_VOICE: '' });
    assert.equal((await call(noVoice, 'POST', '/api/voice/tts', { cookie, body: { text: 'Hola' } })).status, 503);
    const stt = await call(deps, 'POST', '/api/voice/stt', { cookie, body: { audio: Buffer.from('audio').toString('base64'), mimeType: 'audio/webm;codecs=opus' } });
    assert.equal(stt.json().text, 'muéstrame mis clientes');
    assert.equal((await call(deps, 'POST', '/api/voice/stt', { cookie, body: { audio: 'eA==', mimeType: 'text/html' } })).status, 415);
  });

  test('escucha con Whisper de Groq: no necesita Gemini, usa su modelo y español, y descarta alucinaciones', async () => {
    const groq = makeDeps(db, { ...env, GROQ_API_KEY: 'groq-falso' }, { llm: null });
    const { cookie } = await loginCookie(groq);
    const cfg = (await call(groq, 'GET', '/api/voice/config', { cookie })).json();
    assert.equal(cfg.stt, true);
    assert.equal(cfg.sttProvider, 'groq');
    const wav = Buffer.from('RIFF....WAVEdata').toString('base64');
    const r = await call(groq, 'POST', '/api/voice/stt', { cookie, body: { audio: wav, mimeType: 'audio/wav' } });
    assert.equal(r.status, 200);
    assert.equal(r.json().text, 'hola desde groq (whisper-large-v3-turbo, es)');
    // Modelo e idioma configurables
    const custom = makeDeps(db, { ...env, GROQ_API_KEY: 'groq-falso', GROQ_STT_MODEL: 'whisper-large-v3', GROQ_STT_LANGUAGE: 'en' }, { llm: null });
    assert.equal((await call(custom, 'POST', '/api/voice/stt', { cookie, body: { audio: wav, mimeType: 'audio/wav' } })).json().text, 'hola desde groq (whisper-large-v3, en)');
    // Frase inventada por Whisper con silencio → texto vacío
    const silence = Buffer.from('RIFF audio-vacio WAVEdata').toString('base64');
    assert.equal((await call(groq, 'POST', '/api/voice/stt', { cookie, body: { audio: silence, mimeType: 'audio/wav' } })).json().text, '');
    // Clave rechazada → 502 sin filtrar la clave
    const bad = makeDeps(db, { ...env, GROQ_API_KEY: 'clave-mala' }, { llm: null });
    const e = await call(bad, 'POST', '/api/voice/stt', { cookie, body: { audio: wav, mimeType: 'audio/wav' } });
    assert.equal(e.status, 502);
    assert.ok(!e.body.includes('clave-mala'));
    // Sin ninguna opción: «falta configurar» con la variable exacta
    const none = makeDeps(db, { ...env, GEMINI_API_KEY: '', GEMINI_MODEL: '', GROQ_API_KEY: '' }, { llm: null });
    const m = await call(none, 'POST', '/api/voice/stt', { cookie, body: { audio: wav, mimeType: 'audio/wav' } });
    assert.equal(m.status, 503);
    assert.match(m.json().error, /GROQ_API_KEY/);
    assert.equal((await call(none, 'GET', '/api/voice/config', { cookie })).json().stt, false);
  });

  test('chat y tarjetas por HTTP; tick protegido con CRON_SECRET', async () => {
    const deps = makeDeps(db, { ...env, CRON_SECRET: 'secreto-cron-largo' });
    const { cookie } = await loginCookie(deps);
    const r = (await call(deps, 'POST', '/api/chat', { cookie, body: { message: 'Marca como pagado el cobro de Café Brisa' } })).json();
    assert.equal(r.cards.length, 1);
    assert.equal(r.cards[0].status, 'pending');
    const conf = (await call(deps, 'POST', `/api/actions/${r.cards[0].id}/confirm`, { cookie })).json();
    assert.equal(conf.card.status, 'done');
    const msgs = (await call(deps, 'GET', `/api/conversations/${r.conversationId}/messages`, { cookie })).json();
    assert.equal(msgs.messages.length, 2);
    assert.equal(msgs.cards[0].status, 'done');
    assert.equal((await call(deps, 'GET', '/api/jobs/tick')).status, 401);
    assert.equal((await call(deps, 'GET', '/api/jobs/tick', { headers: { authorization: 'Bearer secreto-cron-largo' } })).status, 200);
    assert.equal((await call(makeDeps(db), 'GET', '/api/jobs/tick', { headers: { authorization: 'Bearer x' } })).status, 404);
  });
});
