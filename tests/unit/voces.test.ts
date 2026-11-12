// Voces elegibles, asteriscos que no se leen y preferencias de voz. Sin red ni claves.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../server/config.js';
import { GEMINI_VOICES, resolveVoice, serverVoices } from '../../server/voice/voices.js';
import { synthesize } from '../../server/voice/tts.js';
import { cleanReply } from '../../server/agents/persona.js';
import { toCaption, toSpeakable } from '../../web/src/voice/speechText.js';
import { chunkForSpeech } from '../../web/src/voice/chunker.js';
import { DEFAULT_PREFS, effectiveEngine, parsePrefs, RATE_RANGE, sortBrowserVoices } from '../../web/src/voice/voicePrefs.js';

describe('asteriscos y símbolos: no se leen ni se muestran', () => {
  test('toSpeakable quita negritas, cursivas, viñetas, encabezados, código y emojis', () => {
    const t = toSpeakable('## Resumen\n**Laura Méndez** debe *450 USD* ✅\n* Primero\n* Segundo\n`id_cliente` y [la ficha](https://x.test/a)');
    assert.doesNotMatch(t, /[*#`_[\]]/u);
    assert.doesNotMatch(t, /✅|https?:/u);
    assert.match(t, /Laura Méndez/);
    assert.match(t, /un enlace|la ficha/);
  });
  test('un asterisco suelto o doble nunca llega a la voz', () => {
    for (const s of ['a * b', '**', '***hola***', '*', 'Hecho**', '* * *']) assert.doesNotMatch(toSpeakable(s), /\*/, s);
  });
  test('los símbolos se dicen como se pronuncian', () => {
    assert.match(toSpeakable('Subió 15 %'), /por ciento/);
    assert.match(toSpeakable('Ventas & cobros'), /Ventas y cobros/);
  });
  test('toCaption conserva viñetas y saltos pero sin símbolos de formato', () => {
    const c = toCaption('**Cobros**\n* Laura: 450 USD\n* Pedro: 0 USD');
    assert.doesNotMatch(c, /\*/);
    assert.match(c, /\n/);
    assert.match(c, /Laura: 450 USD/);
  });
  test('el troceado para voz tampoco deja asteriscos', () => {
    const parts = chunkForSpeech('**Hola** Laura. *Tienes* dos cobros pendientes:\n* uno de 450 USD\n* otro de 0 USD.');
    assert.ok(parts.length > 0);
    assert.doesNotMatch(parts.join(' '), /\*/);
  });
  test('cleanReply (servidor) limpia el formato antes de mostrar y de leer', () => {
    const r = cleanReply('**Listo.** Encontré:\n* Laura\n* Pedro\n\n```js\nx\n```\nMás en [aquí](https://x.test).');
    assert.doesNotMatch(r, /\*\*|```|\]\(/);
    assert.match(r, /Laura/);
  });
});

describe('voces del servidor', () => {
  const env = (e: Record<string, string>) => loadConfig(e).env;
  test('Gemini: catálogo con la predeterminada primero y marcada', () => {
    const v = serverVoices('gemini', env({ GEMINI_API_KEY: 'k', GEMINI_TTS_VOICE: 'Kore' }));
    assert.equal(v[0]!.id, 'Kore');
    assert.equal(v.filter(x => x.default).length, 1);
    assert.equal(v.length, GEMINI_VOICES.length);
  });
  test('Gemini: GEMINI_TTS_VOICES sustituye el catálogo y descarta nombres raros', () => {
    const v = serverVoices('gemini', env({ GEMINI_API_KEY: 'k', GEMINI_TTS_VOICES: 'Puck, Leda; ../x; Fenrir' }));
    assert.deepEqual(v.map(x => x.id), ['Puck', 'Leda', 'Fenrir']);
  });
  test('ElevenLabs: «Nombre:id» y la predeterminada', () => {
    const v = serverVoices('elevenlabs', env({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'abcdefghij1', ELEVENLABS_VOICES: 'Ana:ABCDEFGHIJ2, Luis:ABCDEFGHIJ3, mala:x' }));
    assert.deepEqual(v.map(x => x.name), ['Voz de Nyvo', 'Ana', 'Luis']);
    assert.equal(v[0]!.default, true);
  });
  test('navegador: sin voces de servidor', () => assert.deepEqual(serverVoices('navegador', env({})), []));
  test('resolveVoice: solo una voz de la lista llega al proveedor', () => {
    const e = env({ GEMINI_API_KEY: 'k', GEMINI_TTS_VOICE: 'Kore' });
    assert.equal(resolveVoice('gemini', e, 'Puck'), 'Puck');
    assert.equal(resolveVoice('gemini', e, 'voz-inventada'), 'Kore');
    assert.equal(resolveVoice('gemini', e, undefined), 'Kore');
  });
  test('synthesize usa la voz elegida de Gemini y vuelve a la predeterminada si piden otra', async () => {
    const cfg = loadConfig({ GEMINI_API_KEY: 'k', GEMINI_TTS_MODEL: 'tts-falso', GEMINI_TTS_VOICE: 'Kore' });
    const seen: string[] = [];
    const fetcher = (async (_u: unknown, init: { body: string }) => {
      seen.push(JSON.parse(init.body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await synthesize(cfg, fetcher, 'Hola', undefined, 'Puck');
    await synthesize(cfg, fetcher, 'Hola', undefined, 'Nada');
    await synthesize(cfg, fetcher, 'Hola');
    assert.deepEqual(seen, ['Puck', 'Kore', 'Kore']);
  });
});

describe('preferencias de voz del navegador', () => {
  test('lo dañado o fuera de rango vuelve al predeterminado', () => {
    assert.deepEqual(parsePrefs('{no es json'), DEFAULT_PREFS);
    assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
    const p = parsePrefs(JSON.stringify({ engine: 'x', rate: 99, volume: -4, serverVoice: 5 }));
    assert.equal(p.engine, 'auto');
    assert.equal(p.rate, RATE_RANGE.max);
    assert.equal(p.volume, 0);
    assert.equal(p.serverVoice, null);
  });
  test('motor efectivo: sin voz de servidor suena la del navegador; con ella, la que elija el dueño', () => {
    assert.equal(effectiveEngine('navegador', { ...DEFAULT_PREFS, engine: 'servidor' }), 'navegador');
    assert.equal(effectiveEngine(undefined, DEFAULT_PREFS), 'navegador');
    assert.equal(effectiveEngine('gemini', DEFAULT_PREFS), 'servidor');
    assert.equal(effectiveEngine('gemini', { ...DEFAULT_PREFS, engine: 'navegador' }), 'navegador');
  });
  test('las voces en español van primero, las de la PC antes que las de línea', () => {
    const v = (name: string, lang: string, localService: boolean) => ({ voiceURI: name, name, lang, localService });
    const { spanish, other } = sortBrowserVoices([v('Google US', 'en-US', false), v('Online ES', 'es-MX', false), v('Helena', 'es-ES', true), v('Alex', 'en-US', true)]);
    assert.deepEqual(spanish.map(x => x.name), ['Helena', 'Online ES']);
    assert.deepEqual(other.map(x => x.name), ['Alex', 'Google US']);
  });
});
