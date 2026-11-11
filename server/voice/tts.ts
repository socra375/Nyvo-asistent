import type { Config } from '../config.js';
import { missingEnv } from '../config.js';
import { geminiGenerate } from '../llm/gemini.js';
import { LlmHttpError } from '../llm/types.js';
import { HttpError } from '../http/http.js';

/** «navegador» = la voz del propio navegador (Web Speech): no necesita claves ni servidor. */
export type VoiceProvider = 'gemini' | 'elevenlabs' | 'speechify' | 'navegador';
export const VOICE_ENV: Record<VoiceProvider, readonly string[]> = {
  gemini: ['GEMINI_API_KEY', 'GEMINI_TTS_MODEL', 'GEMINI_TTS_VOICE'],
  elevenlabs: ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'],
  speechify: ['SPEECHIFY_API_KEY', 'SPEECHIFY_VOICE_ID'],
  navegador: []
};

export const voiceProvider = (cfg: Config): VoiceProvider => providerFrom(cfg.env);
/**
 * Proveedor de voz. VOICE_PROVIDER manda (gemini, elevenlabs, speechify o navegador/browser). Sin VOICE_PROVIDER: Gemini TTS si
 * ya está configurado del todo y, si no, la voz del navegador, que no necesita nada.
 */
export function providerFrom(env: Record<string, string | undefined>): VoiceProvider {
  const p = env.VOICE_PROVIDER?.trim().toLowerCase();
  if (p === 'elevenlabs' || p === 'speechify') return p;
  if (p === 'navegador' || p === 'browser') return 'navegador';
  if (p) return 'gemini';
  return VOICE_ENV.gemini.every(k => env[k]) ? 'gemini' : 'navegador';
}
export const voiceMissing = (cfg: Config) => missingEnv(cfg.env, VOICE_ENV[voiceProvider(cfg)]);

/** Indicaciones de estilo para Gemini TTS (el estilo se dirige con texto). */
export const DEFAULT_STYLE = 'Lee en español neutro latinoamericano, con tono profesional y cercano, ritmo medio y pausas naturales';

/** Envuelve PCM 16 bits little-endian en un contenedor WAV. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE((channels * bits) / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Frecuencia de muestreo indicada en el tipo MIME (p. ej. audio/L16;codec=pcm;rate=24000). */
export const rateFromMime = (mime: string | undefined) => Number(/rate=(\d+)/.exec(mime ?? '')?.[1] ?? 24000);

/** Limpia el texto para leerlo en voz alta (sin marcas de formato) y aplica el límite de caracteres. */
export function prepareSpeech(text: string, maxChars: number): string {
  const clean = text.replace(/[*_`#>]+/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[<&]/g, m => (m === '&' ? ' y ' : ' '))                 // «<» y «&» pueden confundirse con marcas SSML y hacer que el proveedor rechace el texto
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')                         // caracteres de control e invisibles
    .replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(clean)) throw new HttpError(400, 'No hay texto para leer.');   // vacío o solo signos: los proveedores lo rechazan
  if (clean.length > maxChars) throw new HttpError(413, `El texto supera el límite de ${maxChars} caracteres por petición.`);
  return clean;
}

export interface Speech { audio: Buffer; mimeType: string }

/** Plazo de cada llamada al proveedor de voz: una colgada no deja la petición hasta que Vercel la corta (60 s). */
const TTS_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 350;

/**
 * ElevenLabs: modelo Flash v2.5 por defecto (habla español, responde lo más rápido y gasta la mitad de créditos que Multilingual v2;
 * ELEVENLABS_MODEL_ID lo cambia) y una entonación algo menos «estable» que la de fábrica para que no suene a lectura plana.
 */
export const DEFAULT_ELEVEN_MODEL = 'eleven_flash_v2_5';
export const ELEVEN_VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true };

/** Un error de ElevenLabs, dicho en claro (cuota, clave, plan, voz) en vez de «respondió 401». El cliente cae a la voz del navegador. */
export function elevenLabsError(status: number, raw: string): HttpError {
  let detail = raw;
  try { const j = JSON.parse(raw) as { detail?: { status?: string; message?: string } | string }; detail = typeof j.detail === 'string' ? j.detail : `${j.detail?.status ?? ''} ${j.detail?.message ?? ''}`; } catch { /* texto plano */ }
  if (status === 401 && /quota|credits/i.test(detail)) return new HttpError(429, 'Se acabaron los créditos de ElevenLabs de este mes. Nyvo usará la voz del navegador.');
  if (status === 401) return new HttpError(502, 'ElevenLabs rechazó la clave: ELEVENLABS_API_KEY no es válida.');
  if (status === 402 || /payment|paid_plan|upgrade/i.test(detail)) return new HttpError(402, 'Esa voz de ElevenLabs necesita un plan de pago para usarse por API (el plan gratis no permite voces de la biblioteca).');
  if (status === 404 || /voice_not_found/i.test(detail)) return new HttpError(502, 'ElevenLabs no encuentra esa voz: revisa ELEVENLABS_VOICE_ID o agrégala a «My Voices» en tu cuenta.');
  if (status === 429) return new HttpError(429, 'ElevenLabs está ocupado o se alcanzó el límite. Nyvo usará la voz del navegador por ahora.');
  return new HttpError(502, `ElevenLabs respondió ${status}${detail.trim() ? `: ${detail.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''}.`);
}

/** Un error de Gemini TTS en claro: cuota (429), clave o modelo (401/403/404) o caída (5xx). */
export function geminiTtsError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof LlmHttpError) {
    if (e.status === 429) return new HttpError(429, 'Gemini limitó la voz (cuota). Nyvo usará la voz del navegador por ahora.');
    if (e.status === 401 || e.status === 403) return new HttpError(502, 'Gemini rechazó la clave o no te deja usar ese modelo de voz: revisa GEMINI_API_KEY y GEMINI_TTS_MODEL.');
    if (e.status === 404) return new HttpError(502, 'Gemini no encuentra ese modelo de voz: revisa GEMINI_TTS_MODEL en https://ai.google.dev/gemini-api/docs/speech-generation.');
    return new HttpError(502, e.status ? `Gemini no pudo generar la voz (${e.status}).` : 'Gemini no respondió a tiempo para la voz.');
  }
  return new HttpError(502, 'Gemini no respondió a tiempo para la voz.');
}

/** Un fallo pasajero del proveedor (caída 5xx, red, tiempo, «sin audio») merece un segundo intento; una cuota o una clave mala, no. */
const isTransient = (e: unknown) => {
  if (e instanceof HttpError) return e.status === 502 && /no devolvió audio/.test(e.message);
  if (e instanceof LlmHttpError) return e.status === undefined || e.status >= 500;
  return true;
};
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (!isTransient(e)) throw e;
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    return await fn();
  }
}

export async function synthesize(cfg: Config, fetchImpl: typeof fetch, rawText: string, style?: string): Promise<Speech> {
  if (voiceProvider(cfg) === 'navegador') throw new HttpError(409, 'La voz es la del navegador: se genera en tu equipo, no en el servidor.');
  const missing = voiceMissing(cfg);
  if (missing.length) throw new HttpError(503, `Falta configurar la voz: ${missing.join(', ')}.`);
  const text = prepareSpeech(rawText, cfg.limits.ttsMaxChars);
  const env = cfg.env;

  if (voiceProvider(cfg) === 'elevenlabs') {
    const model = env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_ELEVEN_MODEL;
    // Flash/Turbo v2.5 admiten pista de idioma: evita que una frase corta en español se lea con acento inglés.
    const body: Record<string, unknown> = { text, model_id: model, voice_settings: ELEVEN_VOICE_SETTINGS, ...(/v2_5/.test(model) ? { language_code: 'es' } : {}) };
    const send = (payload: Record<string, unknown>) => fetchImpl(`${cfg.urls.elevenlabs}/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID!)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(TTS_TIMEOUT_MS)
    });
    try {
      const r = await withRetry(async () => {
        let res = await send(body);
        // Un modelo que no admite la pista de idioma responde 400/422: se repite sin ella en vez de quedarse mudo.
        if ((res.status === 400 || res.status === 422) && 'language_code' in body) { delete body.language_code; res = await send(body); }
        if (res.status >= 500) throw new LlmHttpError(`ElevenLabs ${res.status}`, res.status);
        return res;
      });
      if (!r.ok) throw elevenLabsError(r.status, await r.text().catch(() => ''));
      return { audio: Buffer.from(await r.arrayBuffer()), mimeType: 'audio/mpeg' };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, e instanceof LlmHttpError && e.status ? `ElevenLabs respondió ${e.status}.` : 'ElevenLabs no respondió a tiempo.');
    }
  }

  if (voiceProvider(cfg) === 'speechify') {
    // Formato de la API de Speechify según lo que se conoce de su documentación (SIN verificar contra la API real):
    // POST /v1/audio/speech con «Authorization: Bearer», cuerpo {input, voice_id, audio_format, model} y respuesta JSON con audio_data en base64.
    const r = await fetchImpl(`${cfg.urls.speechify}/v1/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SPEECHIFY_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ input: text, voice_id: env.SPEECHIFY_VOICE_ID, audio_format: 'mp3', model: env.SPEECHIFY_MODEL || 'simba-multilingual' }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS)
    }).catch(() => { throw new HttpError(502, 'Speechify no respondió a tiempo.'); });
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      console.warn('speechify', r.status, detail, `(${text.length} caracteres)`);   // queda en los registros: sin esto un 400 suelto no se puede diagnosticar
      throw new HttpError(502, `Speechify respondió ${r.status}${detail ? `: ${detail}` : ''}.`);
    }
    if ((r.headers.get('content-type') ?? '').startsWith('audio/')) return { audio: Buffer.from(await r.arrayBuffer()), mimeType: 'audio/mpeg' };   // por si responde el audio directamente
    const j = await r.json().catch(() => null) as { audio_data?: string } | null;
    if (!j?.audio_data) throw new HttpError(502, 'Speechify no devolvió audio.');
    return { audio: Buffer.from(j.audio_data, 'base64'), mimeType: 'audio/mpeg' };
  }

  try {
    return await withRetry(async () => {
      const resp = await geminiGenerate({ apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_TTS_MODEL!, baseUrl: cfg.urls.gemini, fetch: fetchImpl },
        env.GEMINI_TTS_MODEL!, {
          contents: [{ role: 'user', parts: [{ text: `${style || env.GEMINI_TTS_STYLE || DEFAULT_STYLE}: ${text}` }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_TTS_VOICE } } }
          }
        }, AbortSignal.timeout(TTS_TIMEOUT_MS));
      const part = (resp.candidates as { content?: { parts?: { inlineData?: { data: string; mimeType?: string } }[] } }[] | undefined)?.[0]?.content?.parts?.find(p => p.inlineData);
      // Los modelos de voz a veces contestan con texto (o nada) en vez de audio: es pasajero y se reintenta.
      if (!part?.inlineData?.data) throw new HttpError(502, 'Gemini no devolvió audio.');
      const pcm = Buffer.from(part.inlineData.data, 'base64');
      return { audio: pcmToWav(pcm, rateFromMime(part.inlineData.mimeType)), mimeType: 'audio/wav' } satisfies Speech;
    });
  } catch (e) {
    throw geminiTtsError(e);
  }
}
