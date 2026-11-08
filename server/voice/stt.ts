import type { Config } from '../config.js';
import { HttpError } from '../http/http.js';

/** Quién transcribe lo que el dueño le dice a Nyvo. Groq (Whisper) si hay GROQ_API_KEY; si no, Gemini. */
export type SttProvider = 'groq' | 'gemini';

type Env = Record<string, string | undefined>;

export function sttProviderFrom(env: Env): SttProvider {
  const forced = env.STT_PROVIDER?.trim().toLowerCase();
  if (forced === 'gemini' || forced === 'groq') return forced;
  return env.GROQ_API_KEY ? 'groq' : 'gemini';
}
export const sttProvider = (cfg: Config): SttProvider => sttProviderFrom(cfg.env);

/** Variables que faltan para poder transcribir (vacío = lista). Sugiere Groq cuando no hay ninguna opción. */
export function sttMissing(env: Env): string[] {
  const p = sttProviderFrom(env);
  if (p === 'groq') return env.GROQ_API_KEY ? [] : ['GROQ_API_KEY'];
  if (env.GEMINI_API_KEY) return [];
  return env.STT_PROVIDER?.trim().toLowerCase() === 'gemini' ? ['GEMINI_API_KEY'] : ['GROQ_API_KEY'];
}

const EXT: Record<string, string> = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac' };

/**
 * Whisper en Groq (API compatible con OpenAI): POST /openai/v1/audio/transcriptions, multipart con «file», «model», «language».
 * El formato sale de lo que se conoce de la API; NO se ha verificado contra la API real (la red de desarrollo no llega a Groq).
 */
export async function transcribeWithGroq(cfg: Config, fetchImpl: typeof fetch, audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<string> {
  const env = cfg.env;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${EXT[mimeType] ?? 'wav'}`);
  form.append('model', env.GROQ_STT_MODEL || 'whisper-large-v3-turbo');
  form.append('language', env.GROQ_STT_LANGUAGE || 'es');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const r = await fetchImpl(`${cfg.urls.groq}/v1/audio/transcriptions`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` }, body: form, signal
  });
  if (r.status === 429) throw new HttpError(429, 'Groq limitó las peticiones de voz. Espera un momento.');
  if (!r.ok) throw new HttpError(502, `Groq respondió ${r.status}.`);
  const j = await r.json().catch(() => null) as { text?: string } | null;
  if (typeof j?.text !== 'string') throw new HttpError(502, 'Groq no devolvió texto.');
  return cleanTranscript(j.text);
}

/** Whisper inventa estas frases con silencio o ruido (restos de sus datos de entrenamiento): se descartan. */
const ARTIFACTS = /^(¡?subt[íi]tulos?\b.*|.*amara\.org.*|¡?suscr[íi]bete.*|¡?gracias por ver.*|.*no olvides suscribirte.*)$/i;
export function cleanTranscript(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return ARTIFACTS.test(t) ? '' : t;
}
