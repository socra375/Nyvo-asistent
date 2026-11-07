import type { Config } from '../config.js';
import { missingEnv } from '../config.js';
import { geminiGenerate } from '../llm/gemini.js';
import { HttpError } from '../http/http.js';

export type VoiceProvider = 'gemini' | 'elevenlabs';
export const VOICE_ENV: Record<VoiceProvider, readonly string[]> = {
  gemini: ['GEMINI_API_KEY', 'GEMINI_TTS_MODEL', 'GEMINI_TTS_VOICE'],
  elevenlabs: ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']
};

export const voiceProvider = (cfg: Config): VoiceProvider => (cfg.env.VOICE_PROVIDER === 'elevenlabs' ? 'elevenlabs' : 'gemini');
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
  const clean = text.replace(/[*_`#>]+/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (!clean) throw new HttpError(400, 'No hay texto para leer.');
  if (clean.length > maxChars) throw new HttpError(413, `El texto supera el límite de ${maxChars} caracteres por petición.`);
  return clean;
}

export interface Speech { audio: Buffer; mimeType: string }

export async function synthesize(cfg: Config, fetchImpl: typeof fetch, rawText: string, style?: string): Promise<Speech> {
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
