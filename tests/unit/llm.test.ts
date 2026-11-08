import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeAllDbs, type Db } from '../../server/db/pool.js';
import { createFailover, isEngineFault, type Engine } from '../../server/llm/failover.js';
import { createOpenAiCompat, toOpenAiMessages, toOpenAiTools } from '../../server/llm/openai-compat.js';
import { anyEngineConfigured, buildLlm, engineOrder } from '../../server/llm/build.js';
import { LlmHttpError, type Llm, type LlmRequest, type Turn } from '../../server/llm/types.js';
import { loadConfig } from '../../server/config.js';
import { runTurn } from '../../server/agents/main.js';
import { normalizeSslMode } from '../../server/db/pool.js';
import { call, freshDb, loginCookie, makeDeps, makeUser, needsDb } from '../helpers.js';
import { initialState, startUpstream, upstreamEnv, type Upstream } from '../fakes/upstream.js';

const REQ: LlmRequest = { system: 's', turns: [{ role: 'user', parts: [{ text: 'hola' }] }] };
const answer = (text: string) => ({ text, calls: [], parts: [{ text }] });

/** Motor falso: cuenta llamadas y responde o falla según se le indique. */
function engine(name: string, behave: (n: number, req: LlmRequest) => Promise<string> | string, extra: Partial<Engine> = {}): Engine & { calls: () => number } {
  let n = 0;
  const llm: Llm = { generate: async req => answer(await behave(++n, req)), transcribe: async () => `transcrito por ${name}` };
  return { name, model: `${name}-m`, llm, ...extra, calls: () => n };
}
const failing = (name: string, status?: number) => engine(name, () => { throw new LlmHttpError(`${name} respondió ${status ?? 'fallo'}`, status); });

describe('rotación de motores (failover)', () => {
  test('responde el primero y no toca a los demás', async () => {
    const a = engine('a', () => 'de a'), b = engine('b', () => 'de b');
    const f = createFailover([a, b], { attemptTimeoutMs: 0, cooldownMs: 1000 });
    const r = await f.generate(REQ);
    assert.equal(r.text, 'de a'); assert.equal(r.engine, 'a');
    assert.equal(b.calls(), 0);
  });

  test('si el primero falla pasa al siguiente en la misma petición y deja al caído en enfriamiento', async () => {
    const a = failing('a', 503), b = engine('b', () => 'de b');
    const switches: string[] = [];
    const f = createFailover([a, b], { attemptTimeoutMs: 0, cooldownMs: 1000, onSwitch: e => switches.push(`${e.from}→${e.to}`) });
    const r = await f.generate(REQ);
    assert.equal(r.engine, 'b');
    assert.deepEqual(switches, ['a→b']);
    const st = f.status!();
    assert.equal(st[0]!.state, 'enfriamiento'); assert.equal(st[0]!.failures, 1); assert.match(st[0]!.lastError!, /503/);
    assert.equal(st[1]!.state, 'ok'); assert.equal(st[1]!.answered, 1);
    await f.generate(REQ);
    assert.equal(a.calls(), 1, 'durante el enfriamiento no se vuelve a perder tiempo con el caído');
  });

  test('pasado el enfriamiento se reintenta; si falla otra vez el enfriamiento se duplica; si se recupera vuelve a ser el primero', async () => {
    let t = 1_000_000;
    let healthy = false;
    const a = engine('a', () => { if (!healthy) throw new LlmHttpError('caído', 500); return 'de a'; }), b = engine('b', () => 'de b');
    const f = createFailover([a, b], { attemptTimeoutMs: 0, cooldownMs: 1000, now: () => t });
    await f.generate(REQ);                                        // a falla (enfriamiento 1 s)
    const first = Date.parse(f.status!()[0]!.downUntil!) - t;
    assert.equal(first, 1000);
    t += 1001; await f.generate(REQ);                              // se reintenta y vuelve a fallar
    assert.equal(a.calls(), 2);
    assert.equal(Date.parse(f.status!()[0]!.downUntil!) - t, 2000, 'el enfriamiento se duplica');
    healthy = true;
    t += 2001;
    assert.equal((await f.generate(REQ)).engine, 'a', 'recuperado: vuelve al primero');
    const st = f.status!()[0]!;
    assert.equal(st.failures, 0); assert.equal(st.state, 'ok'); assert.equal(st.downUntil, null);
  });

  test('un error de la petición (400) prueba el siguiente pero no deja al motor en enfriamiento', async () => {
    const a = failing('a', 400), b = engine('b', () => 'de b');
    const f = createFailover([a, b], { attemptTimeoutMs: 0, cooldownMs: 1000 });
    assert.equal((await f.generate(REQ)).engine, 'b');
    assert.equal(f.status!()[0]!.state, 'ok');
    await f.generate(REQ);
    assert.equal(a.calls(), 2, 'sigue siendo el primero');
    assert.equal(isEngineFault(new LlmHttpError('x', 400)), false);
    for (const s of [401, 403, 404, 429, 500, 503]) assert.equal(isEngineFault(new LlmHttpError('x', s)), true, String(s));
    assert.equal(isEngineFault(new TypeError('fetch failed')), true);
  });

  test('un motor que no contesta a tiempo se abandona rápido', async () => {
    const slow = engine('lento', (_n, req) => new Promise((_res, rej) => req.signal!.addEventListener('abort', () => rej(new Error('abortado')))));
    const b = engine('b', () => 'de b');
    const f = createFailover([slow, b], { attemptTimeoutMs: 40, cooldownMs: 1000 });
    const t0 = performance.now();
    const r = await f.generate(REQ);
    assert.equal(r.engine, 'b');
    assert.ok(performance.now() - t0 < 400, 'cambio rápido');
    assert.match(f.status!()[0]!.lastError!, /sin respuesta en 40 ms/);
    assert.equal(f.status!()[0]!.state, 'enfriamiento');
  });

  test('con un solo motor también hay límite (no hay a quién pasar, pero no se queda colgado): por defecto el doble, mínimo 20 s', async () => {
    const quick = engine('solo', async (_n, req) => { assert.ok(req.signal, 'lleva un plazo'); await new Promise(r => setTimeout(r, 60)); return 'tarde pero bien'; });
    assert.equal((await createFailover([quick], { attemptTimeoutMs: 10, cooldownMs: 1000 }).generate(REQ)).text, 'tarde pero bien', 'un motor lento pero vivo no se corta antes de tiempo');
    const hung = engine('solo', (_n, req) => new Promise((_res, rej) => req.signal!.addEventListener('abort', () => rej(new Error('abortado')))));
    const t0 = performance.now();
    await assert.rejects(createFailover([hung], { attemptTimeoutMs: 10, singleEngineLimitMs: 80, cooldownMs: 1000 }).generate(REQ), /solo: sin respuesta en 80 ms/);
    assert.ok(performance.now() - t0 < 600);
    // 0 = sin límite (se conserva la opción)
    const free = engine('solo', async (_n, req) => { assert.equal(req.signal, undefined); return 'ok'; });
    assert.equal((await createFailover([free], { attemptTimeoutMs: 10, singleEngineLimitMs: 0, cooldownMs: 1000 }).generate(REQ)).text, 'ok');
  });

  test('si quien llama cancela, no es culpa del motor: se propaga y no hay enfriamiento', async () => {
    const ac = new AbortController();
    const a = engine('a', (_n, req) => new Promise((_r, rej) => req.signal!.addEventListener('abort', () => rej(new Error('cancelado'))))), b = engine('b', () => 'de b');
    const f = createFailover([a, b], { attemptTimeoutMs: 5000, cooldownMs: 1000 });
    const p = f.generate({ ...REQ, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p, /cancelado/);
    assert.equal(b.calls(), 0);
    assert.equal(f.status!()[0]!.state, 'ok');
  });

  test('si todos fallan, error 503 con el resumen; con todos en enfriamiento se intenta igualmente', async () => {
    const a = failing('a', 503), b = failing('b', 429);
    const f = createFailover([a, b], { attemptTimeoutMs: 0, cooldownMs: 60_000 });
    await assert.rejects(f.generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 503 && /Ningún motor de IA respondió/.test(e.message) && /a: .*503/.test(e.message) && /b: .*429/.test(e.message));
    await assert.rejects(f.generate(REQ));
    assert.equal(a.calls(), 2); assert.equal(b.calls(), 2);
  });

  test('si todos estaban caídos y uno se recupera, responde sin esperar al enfriamiento', async () => {
    let up = false;
    const a = failing('a', 503), b = engine('b', () => { if (!up) throw new LlmHttpError('caído', 503); return 'de b'; });
    const f = createFailover([a, b], { attemptTimeoutMs: 0, cooldownMs: 60_000 });
    await assert.rejects(f.generate(REQ));
    up = true;
    assert.equal((await f.generate(REQ)).text, 'de b');
  });

  test('la transcripción va al motor que sabe transcribir', async () => {
    const f = createFailover([engine('a', () => 'x'), engine('g', () => 'x', { transcribes: true })], { attemptTimeoutMs: 0, cooldownMs: 1 });
    assert.equal(await f.transcribe(Buffer.from('a'), 'audio/wav'), 'transcrito por g');
    const none = createFailover([engine('a', () => 'x')], { attemptTimeoutMs: 0, cooldownMs: 1 });
    await assert.rejects(none.transcribe(Buffer.from('a'), 'audio/wav'), /puede transcribir/);
  });
});

describe('motor compatible con OpenAI (Groq, OpenRouter)', () => {
  const turns: Turn[] = [
    { role: 'user', parts: [{ text: 'clientes' }] },
    { role: 'model', parts: [{ text: 'voy' }, { functionCall: { name: 'delegar', args: { tarea: 'x' } } }, { functionCall: { name: 'otra', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'otra', response: { ok: 2 } } }, { functionResponse: { name: 'delegar', response: { ok: 1 } } }] },
    { role: 'user', parts: [{ text: 'gracias' }] }
  ];

  test('el historial neutro se traduce a mensajes con llamadas y resultados bien emparejados', () => {
    const m = toOpenAiMessages('sistema', turns);
    assert.deepEqual(m.map(x => x.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    const asst = m[2] as { tool_calls: { id: string; function: { name: string; arguments: string } }[]; content: string };
    assert.equal(asst.content, 'voy');
    assert.deepEqual(asst.tool_calls.map(c => c.function.name), ['delegar', 'otra']);
    assert.deepEqual(JSON.parse(asst.tool_calls[0]!.function.arguments), { tarea: 'x' });
    const tools = m.filter(x => x.role === 'tool') as { tool_call_id: string; content: string }[];
    // emparejados por nombre, aunque lleguen en otro orden
    assert.equal(tools[0]!.tool_call_id, asst.tool_calls[1]!.id); assert.equal(tools[0]!.content, '{"ok":2}');
    assert.equal(tools[1]!.tool_call_id, asst.tool_calls[0]!.id);
  });

  test('un resultado sin llamada previa no se envía como «tool» (el proveedor lo rechazaría): pasa a texto', () => {
    const m = toOpenAiMessages('s', [{ role: 'user', parts: [{ functionResponse: { name: 'x', response: { a: 1 } } }] }]);
    assert.deepEqual(m.map(x => x.role), ['system', 'user']);
  });

  test('las herramientas pierden format y nullable y siempre llevan parameters de tipo objeto', () => {
    const t = toOpenAiTools([
      { name: 'a', description: 'd', parameters: { type: 'object', properties: { f: { type: 'string', format: 'date-time', nullable: true }, l: { type: 'array', items: { type: 'string', nullable: true } } }, required: ['f'] } },
      { name: 'b', description: 'sin parámetros' }
    ]);
    const p = t[0]!.function.parameters as { properties: Record<string, Record<string, unknown>> };
    assert.equal(p.properties.f!.format, undefined); assert.equal(p.properties.f!.nullable, undefined);
    assert.equal((p.properties.l!.items as Record<string, unknown>).nullable, undefined);
    assert.deepEqual(t[1]!.function.parameters, { type: 'object', properties: {} });
  });

  const fakeFetch = (status: number, json: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch =>
    (async (url: string, init: RequestInit) => { seen.url = url; seen.init = init; return new Response(JSON.stringify(json), { status }); }) as unknown as typeof fetch;

  test('envía la clave solo en la cabecera, parsea texto y llamadas, y tolera argumentos mal formados', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const llm = createOpenAiCompat({ name: 'Groq', apiKey: 'clave-secreta', model: 'm1', baseUrl: 'https://x.test/openai/v1', fetch: fakeFetch(200, { choices: [{ message: { content: 'hola', tool_calls: [{ function: { name: 'f', arguments: '{"a":1}' } }, { function: { name: 'g', arguments: '{roto' } }] } }] }, seen) });
    const r = await llm.generate({ ...REQ, tools: [{ name: 'f', description: 'd' }] });
    assert.equal(seen.url, 'https://x.test/openai/v1/chat/completions');
    assert.ok(!seen.url!.includes('clave-secreta'));
    assert.equal((seen.init!.headers as Record<string, string>).Authorization, 'Bearer clave-secreta');
    const body = JSON.parse(String(seen.init!.body));
    assert.equal(body.model, 'm1'); assert.equal(body.tool_choice, 'auto');
    assert.equal(r.text, 'hola');
    assert.deepEqual(r.calls, [{ name: 'f', args: { a: 1 } }, { name: 'g', args: {} }]);
    assert.deepEqual(r.parts.map(p => Object.keys(p)[0]), ['text', 'functionCall', 'functionCall']);
  });

  test('errores: código HTTP en el error, respuesta vacía = 502', async () => {
    const base = { name: 'Groq', apiKey: 'k', model: 'm', baseUrl: 'https://x.test/v1' };
    await assert.rejects(createOpenAiCompat({ ...base, fetch: fakeFetch(429, { error: 'cuota' }) }).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 429);
    await assert.rejects(createOpenAiCompat({ ...base, fetch: fakeFetch(200, { choices: [{ message: { content: '' } }] }) }).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 502);
  });
});

describe('construcción de la rotación desde las variables', () => {
  const cfg = (env: Record<string, string>) => loadConfig({ NYVO_OWNER_EMAIL: 'a@b.c', ...env });
  test('orden por defecto, LLM_PROVIDERS, nombres desconocidos y motores incompletos', () => {
    assert.deepEqual(engineOrder({}).map(d => d.name), ['gemini', 'groq', 'openrouter']);
    assert.deepEqual(engineOrder({ LLM_PROVIDERS: ' Groq , gemini, groq, nada ' }).map(d => d.name), ['groq', 'gemini']);
    assert.equal(buildLlm(cfg({}), fetch), null);
    assert.equal(buildLlm(cfg({ GEMINI_API_KEY: 'k' }), fetch), null, 'clave sin modelo: no cuenta');
    assert.equal(anyEngineConfigured({ GROQ_API_KEY: 'k', GROQ_MODEL: 'm' }), true);
    const l = buildLlm(cfg({ GROQ_API_KEY: 'k', GROQ_MODEL: 'm', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'g', LLM_PROVIDERS: 'groq,gemini' }), fetch)!;
    assert.deepEqual(l.status!().map(s => s.name), ['groq', 'gemini']);
    assert.ok(JSON.stringify(l.status!()).indexOf('"k"') < 0, 'el estado no incluye claves');
  });
});

describe('rotación de punta a punta (servidores falsos)', needsDb, () => {
  let db: Db; let userId: string; let up: Upstream; let env: Record<string, string>;
  before(async () => { db = await freshDb(); userId = await makeUser(db); up = await startUpstream(); env = { ...upstreamEnv(up.url, up.state), GROQ_API_KEY: 'groq-falso', GROQ_MODEL: 'llama-falso', LLM_COOLDOWN_MS: '60000' }; });
  after(async () => { await up.close(); await closeAllDbs(); });
  beforeEach(() => { Object.assign(up.state, initialState()); env.NOTION_ROOT_PAGE_ID = up.state.notionRoot; });

  test('Gemini cae (503): el turno completo se resuelve con Groq, con herramientas, y el siguiente turno ni lo intenta', async () => {
    const deps = makeDeps(db, env);
    up.state.geminiFail = 503;
    const r = await runTurn(deps, { userId, conversationId: null, message: '¿Qué clientes tengo?' });
    assert.match(r.reply, /Laura Méndez/);
    assert.ok(up.state.groqRequests.length >= 3, 'delegó y consultó AINova a través de Groq');
    const st = deps.llm!.status!();
    assert.equal(st.find(s => s.name === 'gemini')!.state, 'enfriamiento');
    assert.ok(st.find(s => s.name === 'groq')!.answered >= 3);
    const geminiCalls = up.state.geminiRequests.length;
    await runTurn(deps, { userId, conversationId: null, message: 'hola' });
    assert.equal(up.state.geminiRequests.length, geminiCalls, 'Gemini está en enfriamiento: no se pierde tiempo con él');
  });

  test('la conversación puede cambiar de motor a mitad: el historial se entiende en el otro formato', async () => {
    const deps = makeDeps(db, env);
    const first = await runTurn(deps, { userId, conversationId: null, message: '¿Qué clientes tengo?' });   // Gemini
    assert.match(first.reply, /Laura Méndez/);
    up.state.geminiFail = 500;
    const second = await runTurn(deps, { userId, conversationId: first.conversationId, message: 'ahora los clientes otra vez' });   // Groq, con el historial de Gemini
    assert.match(second.reply, /Laura Méndez/);
    assert.ok(up.state.groqRequests.length > 0);
  });

  test('si fallan todos, la API responde 503 con un mensaje claro (no «Error interno») y la ruta de estado lo refleja', async () => {
    const deps = makeDeps(db, env);
    const { cookie } = await loginCookie(deps);
    up.state.geminiFail = 503; up.state.groqFail = 429;
    const r = await call(deps, 'POST', '/api/chat', { cookie, body: { message: 'hola' }, headers: { origin: 'http://nyvo.test' } });
    assert.equal(r.status, 503);
    assert.equal(r.json().code, 'motor_ia');
    assert.match(r.json().error, /Ningún motor de IA respondió/);
    const s = await call(deps, 'GET', '/api/llm/status', { cookie });
    assert.equal(s.status, 200);
    const j = s.json();
    assert.equal(j.rotation, true);
    assert.deepEqual(j.order, ['gemini', 'groq', 'openrouter']);
    assert.deepEqual(j.engines.map((e: { name: string; state: string }) => [e.name, e.state]), [['gemini', 'enfriamiento'], ['groq', 'enfriamiento']]);
    assert.deepEqual(j.notConfigured, [{ name: 'openrouter', missingEnv: ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL'] }]);
    assert.ok(!r.body.includes('groq-falso') && !s.body.includes('groq-falso'), 'ninguna clave en las respuestas');
    // El flujo en vivo también lo cuenta bien
    const live = await call(deps, 'POST', '/api/chat/stream', { cookie, body: { message: 'hola' }, headers: { origin: 'http://nyvo.test' } });
    const last = JSON.parse(live.body.trim().split('\n').pop()!);
    assert.equal(last.tipo, 'error'); assert.equal(last.status, 503);
  });

  test('un motor colgado ya no deja la petición hasta que Vercel la mata: el turno responde dentro de su plazo', async () => {
    const hang: Llm = { generate: req => new Promise((_res, rej) => req.signal?.addEventListener('abort', () => rej(new Error('abortado')))), transcribe: async () => '' };
    const deps = makeDeps(db, { ...env, TURN_BUDGET_MS: '1000' }, { llm: hang });
    const t0 = performance.now();
    const r = await runTurn(deps, { userId, conversationId: null, message: 'hola' });
    const took = performance.now() - t0;
    assert.ok(took < 2500, `respondió en ${Math.round(took)} ms`);
    assert.equal(r.partial, true);
    assert.match(r.reply, /El motor de IA no respondió a tiempo/);
    assert.match(r.reply, /GROQ_MODEL/, 'dice qué hacer');
    assert.equal(r.timing!.llmCalls, 1);
    assert.equal(r.timing!.ok, 0);
    assert.ok(r.timing!.lastError, 'el registro lleva el motivo');
  });

  test('cada turno informa dónde se fue el tiempo (llamadas, motor, más lenta)', async () => {
    const deps = makeDeps(db, env);
    const r = await runTurn(deps, { userId, conversationId: null, message: '¿Qué clientes tengo?' });
    assert.ok(r.timing!.llmCalls >= 3, 'delegar + herramienta + respuesta final');
    assert.deepEqual(r.timing!.engines, ['gemini']);
    assert.ok(r.timing!.totalMs! >= r.timing!.slowestMs);
    const { cookie } = await loginCookie(deps);
    const live = await call(deps, 'POST', '/api/chat/stream', { cookie, body: { message: '¿Qué clientes tengo?' }, headers: { origin: 'http://nyvo.test' } });
    const fin = JSON.parse(live.body.trim().split('\n').pop()!);
    assert.equal(fin.tipo, 'fin'); assert.ok(fin.timing.llmCalls >= 3);
  });

  test('GEMINI_THINKING_BUDGET solo se envía si se configura', async () => {
    await runTurn(makeDeps(db, env), { userId, conversationId: null, message: 'hola' });
    const gc = (i: number) => (up.state.geminiRequests[i]!.body.generationConfig as Record<string, unknown>);
    assert.equal(gc(0).thinkingConfig, undefined);
    await runTurn(makeDeps(db, { ...env, GEMINI_THINKING_BUDGET: '0' }), { userId, conversationId: null, message: 'hola' });
    assert.deepEqual(gc(up.state.geminiRequests.length - 1).thinkingConfig, { thinkingBudget: 0 });
    await runTurn(makeDeps(db, { ...env, GEMINI_THINKING_BUDGET: 'mucho' }), { userId, conversationId: null, message: 'hola' });
    assert.equal(gc(up.state.geminiRequests.length - 1).thinkingConfig, undefined, 'un valor no numérico se ignora');
  });

  test('sin ningún motor: «falta configurar» y la ruta de estado dice qué falta', async () => {
    const none = makeDeps(db, { ...env, GEMINI_API_KEY: '', GEMINI_MODEL: '', GROQ_API_KEY: '', GROQ_MODEL: '' });
    const { cookie } = await loginCookie(none);
    assert.equal(none.llm, null);
    const j = (await call(none, 'GET', '/api/llm/status', { cookie })).json();
    assert.equal(j.rotation, false); assert.deepEqual(j.engines, []);
    assert.equal(j.notConfigured.length, 3);
  });
});

test('SSL de la base: se escribe verify-full explícito (mismo comportamiento que ya aplica pg) y se respeta lo demás', () => {
  assert.equal(normalizeSslMode('postgres://u:p@h/db?sslmode=require'), 'postgres://u:p@h/db?sslmode=verify-full');
  assert.equal(normalizeSslMode('postgres://u:p@h/db?sslmode=prefer&channel_binding=require'), 'postgres://u:p@h/db?sslmode=verify-full&channel_binding=require');
  assert.equal(normalizeSslMode('postgres://u:p@h/db?x=1&sslmode=verify-ca'), 'postgres://u:p@h/db?x=1&sslmode=verify-full');
  assert.equal(normalizeSslMode('postgres://u:p@h/db?sslmode=verify-full'), 'postgres://u:p@h/db?sslmode=verify-full');
  assert.equal(normalizeSslMode('postgres://u:p@h/db?sslmode=disable'), 'postgres://u:p@h/db?sslmode=disable');
  assert.equal(normalizeSslMode('postgres://u:p@localhost/db'), 'postgres://u:p@localhost/db');
});
