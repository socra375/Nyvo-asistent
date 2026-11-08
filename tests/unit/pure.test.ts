import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt, encrypt, hashPassword, parseKey, safeEqual, verifyPassword } from '../../server/crypto.js';
import { matchWakeWord, WakeWordGate } from '../../web/src/voice/wakeword.js';
import { toLlmSchema, llmName } from '../../server/llm/types.js';
import { pcmToWav, prepareSpeech, providerFrom, rateFromMime } from '../../server/voice/tts.js';
import { pickSpanishVoice } from '../../web/src/voice/voicePick.js';
import { checkIdToken } from '../../server/auth/google.js';
import { notionId, textToBlocks } from '../../connectors/notion/index.js';
import { driveEscape, kindOf } from '../../connectors/google-drive/index.js';
import { backoffSeconds } from '../../server/jobs/queue.js';
import { loadConfig, missingEnv } from '../../server/config.js';
import { isSameOriginWrite } from '../../server/http/http.js';
import { slimResult } from '../../server/actions/actions.js';
import { migrationPolicy } from '../../server/db/migrate.js';
import { cleanTranscript, sttMissing, sttProviderFrom } from '../../server/voice/stt.js';

test('cifrado AES-GCM: ida y vuelta, y falla si se altera', () => {
  const key = parseKey(Buffer.alloc(32, 1).toString('base64'))!;
  const box = encrypt('token-secreto', key);
  assert.notEqual(box, 'token-secreto');
  assert.equal(decrypt(box, key), 'token-secreto');
  const parts = box.split('.');
  parts[3] = Buffer.from('otro').toString('base64url');
  assert.throws(() => decrypt(parts.join('.'), key));
  assert.equal(parseKey('corta'), null);
  assert.ok(parseKey('a'.repeat(64)));
});

test('contraseñas con scrypt y comparación constante', async () => {
  const h = await hashPassword('una-clave-larga-123');
  assert.ok(await verifyPassword('una-clave-larga-123', h));
  assert.equal(await verifyPassword('otra', h), false);
  assert.equal(await verifyPassword('x', null), false);
  assert.ok(safeEqual('a', 'a'));
  assert.equal(safeEqual('a', 'b'), false);
  assert.equal(safeEqual(undefined, 'b'), false);
});

test('palabra clave: acepta «Oye Nyvo» y sus variantes', () => {
  for (const t of ['Oye Nyvo', 'oye, Nivo, muéstrame los cobros', '¡Oye Nibo!', 'bueno... oye naivo', 'OYE NI VO']) {
    assert.ok(matchWakeWord(t).matched, t);
  }
  assert.equal(matchWakeWord('Oye Nyvo, muéstrame mis clientes').command, 'muestrame mis clientes');
});

test('palabra clave: no se activa con palabras parecidas', () => {
  for (const t of ['oye nuevo', 'oye, nueva idea', 'subió de nivel', 'oye nivel', 'oye', 'Nyvo', 'nivo', 'oye nivoso', 'oye nervio', 'joye nyvo', 'noye nyvo']) {
    assert.equal(matchWakeWord(t).matched, false, t);
  }
});

test('palabra clave: espera entre activaciones', () => {
  const g = new WakeWordGate(5000);
  assert.ok(g.check('oye nyvo', 1000).matched);
  assert.equal(g.check('oye nyvo', 3000).matched, false);
  assert.ok(g.check('oye nyvo', 7000).matched);
});

test('esquemas MCP se convierten al subconjunto de Gemini', () => {
  const s = toLlmSchema({
    $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', maxLength: 200 },
      status: { type: 'string', enum: ['activo', 'inactivo'] },
      followUp: { type: ['string', 'null'], pattern: '^\\d{4}' },
      any: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0 }] }
    },
    required: ['query', 'noexiste']
  });
  assert.deepEqual(s, {
    type: 'object',
    properties: { query: { type: 'string' }, status: { type: 'string', enum: ['activo', 'inactivo'] }, followUp: { type: 'string', nullable: true }, any: { type: 'integer', minimum: 0 } },
    required: ['query']
  });
  assert.equal(llmName('google-drive__buscar archivos!'), 'google-drive__buscar_archivos_');
});

test('voz: límite de caracteres, limpieza y WAV', () => {
  assert.equal(prepareSpeech('**Hola** [AINova](https://x.y)', 100), 'Hola AINova');
  assert.throws(() => prepareSpeech('a'.repeat(11), 10), /límite de 10/);
  assert.throws(() => prepareSpeech('  ', 10));
  const wav = pcmToWav(Buffer.alloc(100), 24000);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 144);
  assert.equal(rateFromMime('audio/L16;codec=pcm;rate=16000'), 16000);
  assert.equal(rateFromMime(undefined), 24000);
});

test('id_token de Google: valida emisor, audiencia, caducidad y correo verificado', () => {
  const tok = (c: object) => `x.${Buffer.from(JSON.stringify(c)).toString('base64url')}.y`;
  const base = { iss: 'https://accounts.google.com', aud: 'cid', exp: 2000, email: 'A@B.com', email_verified: true, name: 'A' };
  assert.deepEqual(checkIdToken(tok(base), 'cid', 1000), { email: 'a@b.com', name: 'A' });
  assert.throws(() => checkIdToken(tok({ ...base, aud: 'otro' }), 'cid', 1000));
  assert.throws(() => checkIdToken(tok({ ...base, iss: 'https://malo' }), 'cid', 1000));
  assert.throws(() => checkIdToken(tok(base), 'cid', 3000));
  assert.throws(() => checkIdToken(tok({ ...base, email_verified: false }), 'cid', 1000));
});

test('Notion: ids y bloques', () => {
  assert.equal(notionId('https://www.notion.so/Nyvo-0123456789abcdef0123456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(notionId('01234567-89ab-cdef-0123-456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.throws(() => notionId('nada'));
  const b = textToBlocks('# Título\n- punto\n\ntexto') as { type: string }[];
  assert.deepEqual(b.map(x => x.type), ['heading_2', 'bulleted_list_item', 'paragraph']);
});

test('Drive: escape de consultas y tipos', () => {
  assert.equal(driveEscape("o'hara\\x"), "o\\'hara\\\\x");
  assert.equal(kindOf('application/vnd.google-apps.spreadsheet'), 'Hoja');
  assert.equal(kindOf('image/png'), 'Imagen');
});

test('trabajos: espera creciente entre reintentos', () => {
  assert.deepEqual([1, 2, 3, 4].map(backoffSeconds), [30, 60, 120, 240]);
  assert.equal(backoffSeconds(20), 3600);
});

test('configuración: variables que faltan y límites', () => {
  assert.deepEqual(missingEnv({ A: 'x', B: ' ' }, ['A', 'B', 'C']), ['B', 'C']);
  const c = loadConfig({ NYVO_OWNER_EMAIL: ' A@b.com , c@d.com', TTS_MAX_CHARS: '900' });
  assert.deepEqual(c.ownerEmails, ['a@b.com', 'c@d.com']);
  assert.equal(c.limits.ttsMaxChars, 900);
  assert.equal(loadConfig({}).limits.specialistMaxCalls, 8);
});

test('escrituras solo desde el mismo origen', () => {
  const r = (h: Record<string, string>) => ({ headers: { host: 'nyvo.test', ...h } }) as never;
  assert.ok(isSameOriginWrite(r({})));
  assert.ok(isSameOriginWrite(r({ origin: 'https://nyvo.test', 'sec-fetch-site': 'same-origin' })));
  assert.equal(isSameOriginWrite(r({ origin: 'https://malo.test' })), false);
  assert.equal(isSameOriginWrite(r({ 'sec-fetch-site': 'cross-site' })), false);
});

test('minimización: del resultado de una herramienta solo se guardan identificadores y el tamaño', () => {
  const r = slimResult({ id: 'abc', concept: 'Sitio web de Ana Pérez', amount: '450.00', email: 'ana@x.com', status: 'pagado', pageId: 'p1', url: 'https://notion.so/p1' });
  assert.deepEqual(Object.keys(r).sort(), ['caracteres', 'id', 'pageId', 'status', 'url']);
  assert.ok(!JSON.stringify(r).includes('Ana') && !JSON.stringify(r).includes('ana@x.com'));
  assert.deepEqual(Object.keys(slimResult([{ name: 'Laura', email: 'l@x.com' }])), ['caracteres'], 'una lista de clientes no deja nada');
  assert.deepEqual(Object.keys(slimResult(null)), ['caracteres']);
  assert.equal(slimResult({ id: 'x'.repeat(301) }).id, undefined, 'un «id» enorme no se cuela');
});

test('migraciones: en Vercel solo se aplican en producción (las vistas previas comparten la base)', () => {
  const flag = ['node', 'migrate.ts', '--if-configured', '--production-only'];
  assert.equal(migrationPolicy(flag, { VERCEL_ENV: 'production' }).run, true);
  assert.equal(migrationPolicy(flag, { VERCEL_ENV: 'preview' }).run, false);
  assert.match(migrationPolicy(flag, { VERCEL_ENV: 'preview' }).reason ?? '', /preview.*comparte la base de producción/);
  assert.equal(migrationPolicy(flag, { VERCEL_ENV: 'development' }).run, false);
  assert.equal(migrationPolicy(flag, {}).run, true, 'fuera de Vercel (local, CI) sí migra');
  assert.equal(migrationPolicy(['node', 'migrate.ts'], { VERCEL_ENV: 'preview' }).run, true, 'sin la bandera no cambia el comportamiento manual');
});

test('escucha: Groq si hay clave, Gemini si no; STT_PROVIDER manda; faltantes exactos', () => {
  assert.equal(sttProviderFrom({}), 'gemini');
  assert.equal(sttProviderFrom({ GROQ_API_KEY: 'k' }), 'groq');
  assert.equal(sttProviderFrom({ GROQ_API_KEY: 'k', STT_PROVIDER: ' Gemini ' }), 'gemini');
  assert.equal(sttProviderFrom({ STT_PROVIDER: 'groq' }), 'groq');
  assert.deepEqual(sttMissing({}), ['GROQ_API_KEY']);
  assert.deepEqual(sttMissing({ GROQ_API_KEY: 'k' }), []);
  assert.deepEqual(sttMissing({ GEMINI_API_KEY: 'k' }), [], 'Gemini solo necesita la clave (modelo por defecto)');
  assert.deepEqual(sttMissing({ STT_PROVIDER: 'gemini' }), ['GEMINI_API_KEY']);
  assert.deepEqual(sttMissing({ STT_PROVIDER: 'groq' }), ['GROQ_API_KEY']);
});

test('Whisper: se descartan las frases que inventa con silencio, y se conserva lo que dice el dueño', () => {
  for (const t of ['Subtítulos realizados por la comunidad de Amara.org', '¡Suscríbete!', 'Gracias por ver el vídeo', 'Subtítulos por Amara.org']) assert.equal(cleanTranscript(t), '', t);
  for (const t of ['Gracias.', 'muéstrame mis clientes', 'Anota que el proveedor sube precios en enero', 'suscripción de Notion vence mañana']) assert.equal(cleanTranscript(t), t);
  assert.equal(cleanTranscript('  hola \n  Nyvo  '), 'hola Nyvo');
});

test('voz del navegador: elige sola la mejor voz en español', () => {
  const v = (name: string, lang: string, localService = true) => ({ name, lang, localService });
  const voices = [v('Alex', 'en-US'), v('Monica', 'es-ES'), v('Google español de Estados Unidos', 'es-US', false), v('Paulina', 'es-MX'), v('Jorge', 'es-ES')];
  assert.equal(pickSpanishVoice(voices, 'es-MX')?.name, 'Paulina', 'el idioma exacto del navegador gana');
  assert.equal(pickSpanishVoice(voices, 'es-AR')?.name, 'Google español de Estados Unidos', 'sin exacta: América y voz «natural» antes que España');
  assert.equal(pickSpanishVoice([v('Alex', 'en-US')], 'es-MX'), null, 'sin voces en español no inventa');
  assert.equal(pickSpanishVoice([], 'es'), null);
  assert.equal(pickSpanishVoice([v('X', 'es_MX')], 'es-mx')?.name, 'X', 'acepta es_MX y mayúsculas');
});

test('proveedor de voz: manda VOICE_PROVIDER; sin él, Gemini si está completo y si no, el navegador', () => {
  assert.equal(providerFrom({}), 'navegador');
  assert.equal(providerFrom({ VOICE_PROVIDER: ' Navegador ' }), 'navegador');
  assert.equal(providerFrom({ VOICE_PROVIDER: 'browser' }), 'navegador');
  assert.equal(providerFrom({ VOICE_PROVIDER: 'speechify' }), 'speechify');
  assert.equal(providerFrom({ GEMINI_API_KEY: 'k', GEMINI_TTS_MODEL: 'm', GEMINI_TTS_VOICE: 'v' }), 'gemini');
  assert.equal(providerFrom({ GEMINI_API_KEY: 'k' }), 'navegador', 'Gemini incompleto no cuenta');
  assert.equal(providerFrom({ VOICE_PROVIDER: 'gemini' }), 'gemini');
});
