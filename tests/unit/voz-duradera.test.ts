// Voz que no se queda muda: errores del proveedor dichos en claro, reintento de fallos pasajeros, ElevenLabs con modelo rápido,
// transcripción con proveedor de respaldo y la voz del navegador cuando el servidor no puede hablar. Sin red ni claves.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../server/config.js';
import { elevenLabsError, synthesize, DEFAULT_ELEVEN_MODEL, ELEVEN_VOICE_SETTINGS } from '../../server/voice/tts.js';
import { transcribeAudio } from '../../server/voice/stt.js';
import { HttpError } from '../../server/http/http.js';
import { LlmHttpError, type Llm } from '../../server/llm/types.js';
import { createFallback, isVoiceProviderFault } from '../../web/src/voice/fallback.js';

const audioOk = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } }] }), { status: 200 });
const textOnly = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'no puedo' }] } }] }), { status: 200 });
const err = (status: number, body = '{}') => () => new Response(body, { status });

/** `fetch` que anota cada petición y contesta según el guion (una respuesta por llamada; la última se repite). */
/** Whisper envía un formulario, no JSON: solo se lee el cuerpo cuando es texto. */
function upstream(...script: (() => Response)[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (u: string, init?: { body?: unknown }) => { calls.push({ url: String(u), body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} }); return script[Math.min(calls.length - 1, script.length - 1)]!(); }) as unknown as typeof fetch;
  return { f, calls };
}
const geminiCfg = loadConfig({ GEMINI_API_KEY: 'k', GEMINI_TTS_MODEL: 'tts-falso', GEMINI_TTS_VOICE: 'Kore' });
const elevenCfg = (extra: Record<string, string> = {}) => loadConfig({ VOICE_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', ...extra });
const rejects = (p: Promise<unknown>, status: number, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof HttpError && e.status === status && re.test(e.message));

describe('voz de Gemini en el servidor', () => {
  test('cuota agotada (429): mensaje claro, sin el detalle del proveedor, y sin reintentar (no se arregla en un segundo)', async () => {
    const u = upstream(err(429, '{"error":{"message":"Resource has been exhausted (e.g. check quota)."}}'));
    await rejects(synthesize(geminiCfg, u.f, 'Hola'), 429, /limitó la voz \(cuota\).*navegador/);
    assert.equal(u.calls.length, 1);
  });

  test('clave o modelo malos: dicen qué variable revisar', async () => {
    await rejects(synthesize(geminiCfg, upstream(err(403)).f, 'Hola'), 502, /GEMINI_API_KEY y GEMINI_TTS_MODEL/);
    await rejects(synthesize(geminiCfg, upstream(err(404)).f, 'Hola'), 502, /GEMINI_TTS_MODEL/);
  });

  test('una caída pasajera (503) se reintenta una vez y se recupera', async () => {
    const u = upstream(err(503), audioOk);
    const r = await synthesize(geminiCfg, u.f, 'Hola');
    assert.equal(r.mimeType, 'audio/wav');
    assert.equal(u.calls.length, 2);
  });

  test('si la caída sigue, 502 con el código (no «Error interno» ni «motor de IA»)', async () => {
    const u = upstream(err(503));
    await rejects(synthesize(geminiCfg, u.f, 'Hola'), 502, /no pudo generar la voz \(503\)/);
    assert.equal(u.calls.length, 2, 'un reintento y se rinde');
  });

  test('un modelo de voz que contesta texto en vez de audio se reintenta; si insiste, 502', async () => {
    const u = upstream(textOnly, audioOk);
    assert.equal((await synthesize(geminiCfg, u.f, 'Hola')).mimeType, 'audio/wav');
    await rejects(synthesize(geminiCfg, upstream(textOnly).f, 'Hola'), 502, /no devolvió audio/);
  });

  test('un error del proveedor de voz no es un LlmHttpError que la API tome por «motores de IA caídos»', async () => {
    await assert.rejects(synthesize(geminiCfg, upstream(err(500)).f, 'Hola'), (e: unknown) => !(e instanceof LlmHttpError) && e instanceof HttpError);
  });
});

describe('voz de ElevenLabs en el servidor', () => {
  test('por defecto usa Flash v2.5 con pista de idioma español y entonación con vida', async () => {
    const u = upstream(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const r = await synthesize(elevenCfg(), u.f, 'Hola');
    assert.equal(r.mimeType, 'audio/mpeg');
    assert.equal(u.calls[0]!.body.model_id, DEFAULT_ELEVEN_MODEL);
    assert.equal(DEFAULT_ELEVEN_MODEL, 'eleven_flash_v2_5');
    assert.equal(u.calls[0]!.body.language_code, 'es');
    assert.deepEqual(u.calls[0]!.body.voice_settings, ELEVEN_VOICE_SETTINGS);
  });

  test('ELEVENLABS_MODEL_ID manda; un modelo sin pista de idioma no la lleva', async () => {
    const u = upstream(() => new Response(new Uint8Array([1]), { status: 200 }));
    await synthesize(elevenCfg({ ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2' }), u.f, 'Hola');
    assert.equal(u.calls[0]!.body.model_id, 'eleven_multilingual_v2');
    assert.equal('language_code' in u.calls[0]!.body, false);
  });

  test('si el modelo rechaza la pista de idioma (400), se repite sin ella en vez de quedarse mudo', async () => {
    const u = upstream(err(400, '{"detail":{"message":"language_code not supported"}}'), () => new Response(new Uint8Array([1]), { status: 200 }));
    assert.equal((await synthesize(elevenCfg(), u.f, 'Hola')).mimeType, 'audio/mpeg');
    assert.equal(u.calls.length, 2);
    assert.equal('language_code' in u.calls[1]!.body, false);
  });

  test('errores en claro: créditos, clave, plan de pago, voz inexistente, límite y caída', () => {
    const e = elevenLabsError;
    assert.equal(e(401, '{"detail":{"status":"quota_exceeded","message":"You have 0 credits remaining"}}').status, 429);
    assert.match(e(401, '{"detail":{"status":"quota_exceeded","message":"You have 0 credits remaining"}}').message, /créditos.*navegador/);
    assert.match(e(401, '{"detail":{"status":"invalid_api_key"}}').message, /ELEVENLABS_API_KEY/);
    assert.equal(e(402, '{}').status, 402);
    assert.match(e(403, '{"detail":{"status":"paid_plan_required"}}').message, /plan de pago/);
    assert.match(e(404, '{"detail":{"status":"voice_not_found"}}').message, /ELEVENLABS_VOICE_ID/);
    assert.equal(e(429, '{}').status, 429);
    assert.match(e(418, 'texto plano raro').message, /418: texto plano raro/);
  });

  test('una caída (500) se reintenta una vez; si sigue, 502', async () => {
    const u = upstream(err(500));
    await rejects(synthesize(elevenCfg(), u.f, 'Hola'), 502, /ElevenLabs respondió 500/);
    assert.equal(u.calls.length, 2);
  });

  test('sin créditos (401) no se reintenta y el mensaje no filtra la clave', async () => {
    const u = upstream(err(401, '{"detail":{"status":"quota_exceeded","message":"0 credits"}}'));
    await assert.rejects(synthesize(elevenCfg({ ELEVENLABS_API_KEY: 'clave-secreta-123' }), u.f, 'Hola'), (e: unknown) => e instanceof HttpError && e.status === 429 && !e.message.includes('clave-secreta-123'));
    assert.equal(u.calls.length, 1);
  });
});

describe('transcripción con proveedor de respaldo', () => {
  const groqOk = (text: string) => () => new Response(JSON.stringify({ text }), { status: 200 });
  const AUDIO = Buffer.from('audio');
  const fakeLlm = (text: string | Error): Llm & { n: number } => {
    const l = { n: 0, generate: async () => { throw new Error('no'); }, transcribe: async () => { l.n++; if (text instanceof Error) throw text; return text; } };
    return l as Llm & { n: number };
  };
  const cfg = (env: Record<string, string>) => loadConfig(env);

  test('Groq por defecto; si se queda sin cuota (429) responde Gemini', async () => {
    const u = upstream(err(429));
    const llm = fakeLlm('lo dijo gemini');
    assert.equal(await transcribeAudio(cfg({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' }), u.f, llm, AUDIO, 'audio/wav'), 'lo dijo gemini');
    assert.equal(u.calls.length, 1); assert.equal(llm.n, 1);
  });

  test('también con una caída de Groq (5xx) o de red; y a la inversa, si Gemini transcribe primero y falla, entra Groq', async () => {
    assert.equal(await transcribeAudio(cfg({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' }), upstream(err(503)).f, fakeLlm('de gemini'), AUDIO, 'audio/wav'), 'de gemini');
    const net = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    assert.equal(await transcribeAudio(cfg({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' }), net, fakeLlm('de gemini'), AUDIO, 'audio/wav'), 'de gemini');
    const u = upstream(groqOk('hola desde groq'));
    // GROQ_API_KEY presente pero Gemini primero: STT_PROVIDER vacío y Groq presente → Groq primero; probamos Gemini primero con su error.
    const llm = fakeLlm(new LlmHttpError('Gemini 429', 429));
    assert.equal(await transcribeAudio(cfg({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' }), upstream(groqOk('hola desde groq')).f, llm, AUDIO, 'audio/wav'), 'hola desde groq');
    assert.equal(llm.n, 0, 'con Groq sano, Gemini ni se toca');
    void u;
  });

  test('si Groq rechaza el audio (400) lo intenta Gemini; si fallan los dos, el último error dicho en claro', async () => {
    assert.equal(await transcribeAudio(cfg({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' }), upstream(err(400)).f, fakeLlm('lo entendió gemini'), AUDIO, 'audio/wav'), 'lo entendió gemini');
    await rejects(transcribeAudio(cfg({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' }), upstream(err(429)).f, fakeLlm(new LlmHttpError('Gemini respondió 429: {detalle crudo}', 429)), AUDIO, 'audio/wav'), 429, /Gemini limitó la transcripción/);
    await assert.rejects(transcribeAudio(cfg({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' }), upstream(err(500)).f, fakeLlm(new LlmHttpError('Gemini respondió 503: {detalle crudo}', 503)), AUDIO, 'audio/wav'), (e: unknown) => e instanceof HttpError && e.status === 502 && /Gemini no pudo transcribir \(503\)/.test(e.message) && !/crudo/.test(e.message));
  });

  test('con STT_PROVIDER fijado no hay segundo intento (el dueño eligió ese), y sin otro proveedor listo se informa el fallo', async () => {
    const llm = fakeLlm('no debería');
    await rejects(transcribeAudio(cfg({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k', STT_PROVIDER: 'groq' }), upstream(err(429)).f, llm, AUDIO, 'audio/wav'), 429, /limitó/);
    assert.equal(llm.n, 0);
    await rejects(transcribeAudio(cfg({ GROQ_API_KEY: 'g' }), upstream(err(429)).f, null, AUDIO, 'audio/wav'), 429, /limitó/);
  });

  test('sin Groq, Gemini transcribe; si Gemini falla y hay Groq lo intenta Groq', async () => {
    assert.equal(await transcribeAudio(cfg({ GEMINI_API_KEY: 'k' }), upstream(err(500)).f, fakeLlm('de gemini'), AUDIO, 'audio/wav'), 'de gemini');
    const llm = fakeLlm(new LlmHttpError('caído', 503));
    assert.equal(await transcribeAudio(cfg({ GEMINI_API_KEY: 'k', GROQ_API_KEY: 'g', STT_PROVIDER: '' }), upstream(groqOk('de groq')).f, llm, AUDIO, 'audio/wav'), 'de groq', 'Groq tiene clave, así que es el primero');
  });

  test('los restos que Whisper inventa con silencio se siguen descartando', async () => {
    assert.equal(await transcribeAudio(cfg({ GROQ_API_KEY: 'g' }), upstream(groqOk('Subtítulos realizados por la comunidad de Amara.org')).f, null, AUDIO, 'audio/wav'), '');
  });
});

describe('voz de respaldo en el navegador', () => {
  const fail = (status?: number) => Object.assign(new Error('el servidor no pudo hablar'), status === undefined ? {} : { status });
  const make = (primary: (t: string) => Promise<string>, extra: { now?: () => number } = {}) => {
    const reasons: string[] = [];
    const primaryCalls: string[] = [];
    const fn = createFallback<string, string>({
      primary: async t => { primaryCalls.push(t); return primary(t); },
      fallback: async t => `navegador:${t}`,
      cooldownMs: 60_000, isProviderFault: isVoiceProviderFault, onFallback: r => reasons.push(r), ...extra
    });
    return { fn, reasons, primaryCalls };
  };
  const sig = () => new AbortController().signal;

  test('con el servidor sano, habla el servidor', async () => {
    const { fn, reasons } = make(async t => `servidor:${t}`);
    assert.deepEqual(await fn('Hola', sig()), { from: 'primary', value: 'servidor:Hola' });
    assert.deepEqual(reasons, []);
  });

  test('si el servidor falla (cuota, caída, red) esa frase se lee con el navegador y se deja de insistir un rato', async () => {
    let t = 1000;
    const { fn, reasons, primaryCalls } = make(async () => { throw fail(429); }, { now: () => t });
    assert.deepEqual(await fn('Uno', sig()), { from: 'fallback', value: 'navegador:Uno' });
    assert.deepEqual(await fn('Dos', sig()), { from: 'fallback', value: 'navegador:Dos' });
    assert.deepEqual(primaryCalls, ['Uno'], 'durante el enfriamiento no gasta un viaje por frase ni mezcla dos voces');
    assert.equal(reasons.length, 1, 'el aviso sale una sola vez');
    t += 61_000;
    await fn('Tres', sig());
    assert.deepEqual(primaryCalls, ['Uno', 'Tres'], 'pasado el enfriamiento vuelve a probar el servidor');
  });

  test('un error de la frase (400, 413) la lee el navegador pero no apaga el servidor para las siguientes', async () => {
    const { fn, primaryCalls } = make(async t => { if (t === 'mala') throw fail(400); return `servidor:${t}`; });
    assert.deepEqual(await fn('mala', sig()), { from: 'fallback', value: 'navegador:mala' });
    assert.deepEqual(await fn('buena', sig()), { from: 'primary', value: 'servidor:buena' });
    assert.deepEqual(primaryCalls, ['mala', 'buena']);
  });

  test('una interrupción del usuario (barge-in) no es un fallo: se propaga y no se lee nada con el navegador', async () => {
    const ctrl = new AbortController();
    const { fn, reasons } = make(async () => { ctrl.abort(); throw new DOMException('abortado', 'AbortError'); });
    await assert.rejects(fn('Hola', ctrl.signal), /abortado/);
    assert.deepEqual(reasons, []);
  });

  test('qué cuenta como fallo del proveedor: cuota, clave, caída y red; no una frase rechazada', () => {
    for (const s of [429, 500, 502, 503, 401, 402, 403, 404, undefined]) assert.ok(isVoiceProviderFault(s === undefined ? new TypeError('network') : fail(s)), String(s));
    for (const s of [400, 413, 415, 422]) assert.ok(!isVoiceProviderFault(fail(s)), String(s));
  });
});
