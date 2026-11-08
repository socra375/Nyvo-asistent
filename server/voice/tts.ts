import type { Config } from '../config.js';
import { missingEnv } from '../config.js';
import { geminiGenerate } from '../llm/gemini.js';
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

export async function synthesize(cfg: Config, fetchImpl: typeof fetch, rawText: string, style?: string): Promise<Speech> {
  if (voiceProvider(cfg) === 'navegador') throw new HttpError(409, 'La voz es la del navegador: se genera en tu equipo, no en el servidor.');
  const missing = voiceMissing(cfg);
  if (missing.length) throw new HttpError(503, `Falta configurar la voz: ${missing.join(', ')}.`);
  const text = prepareSpeech(rawText, cfg.limits.ttsMaxChars);
  const env = cfg.env;

  if (voiceProvider(cfg) === 'elevenlabs') {
    const body: Record<string, unknown> = { text };
    if (env.ELEVENLABS_MODEL_ID) body.model_id = env.ELEVENLABS_MODEL_ID;
    const r = await fetchImpl(`${cfg.urls.elevenlabs}/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID!)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body)
    });
    if (!r.ok) throw new HttpError(502, `ElevenLabs respondió ${r.status}.`);
    return { audio: Buffer.from(await r.arrayBuffer()), mimeType: 'audio/mpeg' };
  }

  if (voiceProvider(cfg) === 'speechify') {
    // Formato de la API de Speechify según lo que se conoce de su documentación (SIN verificar contra la API real):
    // POST /v1/audio/speech con «Authorization: Bearer», cuerpo {input, voice_id, audio_format, model} y respuesta JSON con audio_data en base64.
    const r = await fetchImpl(`${cfg.urls.speechify}/v1/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SPEECHIFY_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ input: text, voice_id: env.SPEECHIFY_VOICE_ID, audio_format: 'mp3', model: env.SPEECHIFY_MODEL || 'simba-multilingual' })
    });
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

  const resp = await geminiGenerate({ apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_TTS_MODEL!, baseUrl: cfg.urls.gemini, fetch: fetchImpl },
    env.GEMINI_TTS_MODEL!, {
      contents: [{ role: 'user', parts: [{ text: `${style || env.GEMINI_TTS_STYLE || DEFAULT_STYLE}: ${text}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_TTS_VOICE } } }
      }
    });
  const part = (resp.candidates as { content?: { parts?: { inlineData?: { data: string; mimeType?: string } }[] } }[] | undefined)?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part?.inlineData?.data) throw new HttpError(502, 'Gemini no devolvió audio.');
  const pcm = Buffer.from(part.inlineData.data, 'base64');
  return { audio: pcmToWav(pcm, rateFromMime(part.inlineData.mimeType)), mimeType: 'audio/wav' };
}
