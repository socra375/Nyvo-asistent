// Motores de IA que duran: la escalera de «pensar» de Gemini, respuestas vacías que rotan de motor, tope de salida y el
// reemplazo automático de un modelo que Groq retira. Sin red ni claves: todo contra `fetch` simulados.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGemini, resetThinking } from '../../server/llm/gemini.js';
import { createOpenAiCompat, isMissingModel } from '../../server/llm/openai-compat.js';
import { createFailover, type Engine } from '../../server/llm/failover.js';
import { buildLlm, thinkingIsAuto } from '../../server/llm/build.js';
import { loadConfig } from '../../server/config.js';
import { LlmHttpError, type LlmRequest } from '../../server/llm/types.js';

const REQ: LlmRequest = { system: 's', turns: [{ role: 'user', parts: [{ text: 'hola' }] }] };
const ok = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
const badThinking = () => new Response('{"error":{"message":"Unknown name \\"thinkingBudget\\": Cannot find field."}}', { status: 400 });
type Body = { generationConfig: Record<string, unknown> };

/** `fetch` de Gemini que anota lo recibido y contesta según el guion (una respuesta por llamada; la última se repite). */
function gemini(...script: (() => Response)[]) {
  const bodies: Body[] = [];
  const f = (async (_u: string, init?: { body?: string }) => { bodies.push(JSON.parse(init!.body!)); return script[Math.min(bodies.length - 1, script.length - 1)]!(); }) as unknown as typeof fetch;
  return { f, bodies };
}
const flash = (f: typeof fetch, extra: Record<string, unknown> = {}) => createGemini({ apiKey: 'k', model: 'gemini-flash-lite-latest', baseUrl: 'http://x', fetch: f, thinkingAuto: true, ...extra });

describe('Gemini: escalera de «pensar»', () => {
  beforeEach(() => resetThinking());

  test('empieza pidiendo 0 y, si el modelo lo rechaza, baja a «minimal» y lo recuerda para las siguientes peticiones', async () => {
    const g = gemini(badThinking, () => ok('uno'), () => ok('dos'));
    const llm = flash(g.f);
    assert.equal((await llm.generate(REQ)).text, 'uno');
    assert.deepEqual(g.bodies.map(b => b.generationConfig.thinkingConfig), [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }]);
    assert.equal((await llm.generate(REQ)).text, 'dos');
    assert.deepEqual(g.bodies[2]!.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' }, 'la segunda petición ya no repite el intento fallido');
  });

  test('recorre toda la escalera hasta quedar sin ajuste, y si aun así da 400 informa el error (sin bucle)', async () => {
    const g = gemini(badThinking, badThinking, badThinking, () => ok('al fin'));
    assert.equal((await flash(g.f).generate(REQ)).text, 'al fin');
    assert.deepEqual(g.bodies.map(b => b.generationConfig.thinkingConfig), [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, undefined]);
    resetThinking();
    const always = gemini(badThinking);
    await assert.rejects(flash(always.f).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 400);
    assert.equal(always.bodies.length, 4, 'cuatro intentos y se rinde');
  });

  test('un 400 que no habla de «pensar» se informa tal cual, sin tocar la escalera', async () => {
    const g = gemini(() => new Response('{"error":{"message":"Request payload size exceeds the limit"}}', { status: 400 }));
    await assert.rejects(flash(g.f).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 400);
    assert.equal(g.bodies.length, 1);
  });

  test('con presupuesto fijo (GEMINI_THINKING_BUDGET) se envía ese y solo se quita una vez si el modelo lo rechaza; sin él, no hay ajuste', async () => {
    const g = gemini(badThinking, () => ok('listo'));
    assert.equal((await createGemini({ apiKey: 'k', model: 'm', baseUrl: 'http://x', fetch: g.f, thinkingBudget: 512 }).generate(REQ)).text, 'listo');
    assert.deepEqual(g.bodies.map(b => b.generationConfig.thinkingConfig), [{ thinkingBudget: 512 }, undefined]);
    const plain = gemini(() => ok('x'));
    await createGemini({ apiKey: 'k', model: 'gemini-2.5-pro', baseUrl: 'http://x', fetch: plain.f }).generate(REQ);
    assert.equal(plain.bodies[0]!.generationConfig.thinkingConfig, undefined, 'Pro: lo que decida el modelo');
  });

  test('la transcripción también baja por la escalera (era lo más lento de la voz) y una cadena vacía es válida', async () => {
    const g = gemini(badThinking, () => ok(''));
    assert.equal(await flash(g.f).transcribe(Buffer.from('audio'), 'audio/wav'), '');
    assert.deepEqual(g.bodies.map(b => b.generationConfig.thinkingConfig), [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }]);
  });

  test('solo los Flash sin presupuesto fijo usan la escalera', () => {
    assert.equal(thinkingIsAuto({}, 'gemini-flash-lite-latest'), true);
    assert.equal(thinkingIsAuto({ GEMINI_THINKING_BUDGET: '0' }, 'gemini-flash-lite-latest'), false);
    assert.equal(thinkingIsAuto({}, 'gemini-2.5-pro'), false);
  });

  test('buildLlm arma Gemini Flash con la escalera: la primera petición ya pide el mínimo', async () => {
    const g = gemini(() => ok('hola'));
    const llm = buildLlm(loadConfig({ GEMINI_API_KEY: 'k' }), g.f)!;
    assert.equal((await llm.generate(REQ)).text, 'hola');
    assert.deepEqual(g.bodies[0]!.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  });
});

describe('Gemini: respuestas y tope de salida', () => {
  beforeEach(() => resetThinking());

  test('el tope de salida es de 8192 tokens (también cuentan los de «pensar»)', async () => {
    const g = gemini(() => ok('hola'));
    await flash(g.f).generate(REQ);
    assert.equal(g.bodies[0]!.generationConfig.maxOutputTokens, 8192);
  });

  test('una respuesta vacía no es una respuesta: error con el motivo y sin dejar al motor en enfriamiento', async () => {
    const blocked = gemini(() => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }), { status: 200 }));
    await assert.rejects(flash(blocked.f).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 422 && /bloqueo «SAFETY»/.test(e.message));
    const cut = gemini(() => new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ thought: true }] } }] }), { status: 200 }));
    await assert.rejects(flash(cut.f).generate(REQ), (e: unknown) => e instanceof LlmHttpError && /MAX_TOKENS/.test(e.message));
  });

  test('con la rotación, si Gemini contesta vacío responde el siguiente motor y Gemini sigue disponible', async () => {
    const empty = gemini(() => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }), { status: 200 }));
    const engines: Engine[] = [
      { name: 'gemini', model: 'g', llm: flash(empty.f) },
      { name: 'groq', model: 'q', llm: { generate: async () => ({ text: 'desde groq', calls: [], parts: [{ text: 'desde groq' }] }), transcribe: async () => '' } }
    ];
    const f = createFailover(engines, { attemptTimeoutMs: 0, cooldownMs: 60_000 });
    const r = await f.generate(REQ);
    assert.equal(r.text, 'desde groq');
    assert.equal(f.status!().find(e => e.name === 'gemini')!.state, 'ok', 'un fallo de esta petición no castiga al motor');
  });

  test('una llamada a herramienta sin texto sí es respuesta', async () => {
    const g = gemini(() => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'delegar', args: { tarea: 'x' } } }] } }] }), { status: 200 }));
    const r = await flash(g.f).generate({ ...REQ, tools: [{ name: 'delegar', description: 'd' }] });
    assert.deepEqual(r.calls, [{ name: 'delegar', args: { tarea: 'x' } }]);
  });
});

describe('Groq: el modelo retirado se reemplaza solo', () => {
  const chat = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
  const gone = () => new Response('{"error":{"message":"The model `viejo` does not exist or you do not have access to it.","code":"model_not_found"}}', { status: 404 });
  const list = (...ids: string[]) => () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200 });
  const PREFS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', /^qwen\//];

  /** `fetch` que distingue la lista de modelos de las peticiones de chat. */
  function groq(chats: (() => Response)[], models: () => Response) {
    const seen: { url: string; model?: string }[] = [];
    let n = 0;
    const f = (async (u: string, init?: { body?: string }) => {
      if (u.endsWith('/models')) { seen.push({ url: u }); return models(); }
      seen.push({ url: u, model: JSON.parse(init!.body!).model });
      return chats[Math.min(n++, chats.length - 1)]!();
    }) as unknown as typeof fetch;
    return { f, seen };
  }
  const make = (f: typeof fetch, prefs?: (string | RegExp)[]) => createOpenAiCompat({ name: 'Groq', apiKey: 'k', model: 'viejo', baseUrl: 'https://x.test/openai/v1', fetch: f, modelPreferences: prefs });

  test('si Groq dice que el modelo no existe, pide su lista, elige el primero preferido y repite la petición', async () => {
    const g = groq([gone, () => chat('hola'), () => chat('otra')], list('whisper-large-v3', 'llama-guard-4', 'qwen/qwen3-32b', 'openai/gpt-oss-20b'));
    const llm = make(g.f, PREFS);
    assert.equal((await llm.generate(REQ)).text, 'hola');
    assert.deepEqual(g.seen.map(s => s.model ?? 'lista'), ['viejo', 'lista', 'openai/gpt-oss-20b'], 'gpt-oss-20b va antes que qwen en las preferencias, y whisper/guard nunca se eligen');
    assert.equal((await llm.generate(REQ)).text, 'otra');
    assert.equal(g.seen[3]!.model, 'openai/gpt-oss-20b', 'recuerda el reemplazo: no vuelve a pedir la lista');
    assert.equal(g.seen.filter(s => s.url.endsWith('/models')).length, 1);
  });

  test('sin preferencias, sin lista, o sin ningún modelo preferido disponible: el error original, sin reintentos', async () => {
    const none = groq([gone], list('whisper-large-v3', 'otro/modelo'));
    await assert.rejects(make(none.f, PREFS).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 404 && /does not exist/.test(e.message));
    const noPrefs = groq([gone], list('openai/gpt-oss-20b'));
    await assert.rejects(make(noPrefs.f).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 404);
    assert.equal(noPrefs.seen.length, 1, 'ni siquiera pide la lista');
    const broken = groq([gone], () => new Response('no', { status: 500 }));
    await assert.rejects(make(broken.f, PREFS).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 404);
  });

  test('un reemplazo que también falla se informa (sin bucle) y otros errores no disparan la búsqueda', async () => {
    const g = groq([gone, gone], list('openai/gpt-oss-20b'));
    await assert.rejects(make(g.f, PREFS).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 404);
    assert.equal(g.seen.length, 3, 'chat, lista y un único reintento');
    const limited = groq([() => new Response('{"error":{"message":"rate limit"}}', { status: 429 })], list('openai/gpt-oss-20b'));
    await assert.rejects(make(limited.f, PREFS).generate(REQ), (e: unknown) => e instanceof LlmHttpError && e.status === 429);
    assert.equal(limited.seen.length, 1);
  });

  test('isMissingModel reconoce los avisos de modelo retirado y no confunde otros errores', () => {
    assert.ok(isMissingModel(404, '{"error":{"code":"model_not_found"}}'));
    assert.ok(isMissingModel(400, 'The model `x` has been decommissioned and is no longer supported.'));
    assert.ok(!isMissingModel(404, 'Not found'));
    assert.ok(!isMissingModel(429, 'model_not_found'));
    assert.ok(!isMissingModel(400, 'Invalid request'));
  });
});
