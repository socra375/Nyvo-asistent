import type { Config } from '../config.js';
import { HttpError } from '../http/http.js';
import { LlmHttpError, type Llm } from '../llm/types.js';

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

/** Plazo de cada transcripción: una colgada no deja la petición hasta que Vercel la corta (60 s). */
const STT_TIMEOUT_MS = 20_000;

/**
 * Transcribe con el proveedor elegido y, si falla (cuota, caída, red, tiempo, o un audio que su decodificador no acepta), prueba
 * el otro proveedor que esté configurado: los límites gratuitos de Whisper y de Gemini se acaban y no deben dejar a Nyvo sordo.
 * Con STT_PROVIDER fijado no hay segundo intento: el dueño eligió ese.
 */
export async function transcribeAudio(cfg: Config, fetchImpl: typeof fetch, llm: Llm | null, audio: Buffer, mimeType: string): Promise<string> {
  const env = cfg.env;
  const first = sttProviderFrom(env);
  const ready = { groq: Boolean(env.GROQ_API_KEY?.trim()), gemini: Boolean(llm && env.GEMINI_API_KEY?.trim()) };
  const order: SttProvider[] = env.STT_PROVIDER?.trim() ? [first] : first === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const run = (p: SttProvider, signal: AbortSignal) => p === 'groq' ? transcribeWithGroq(cfg, fetchImpl, audio, mimeType, signal) : llm!.transcribe(audio, mimeType, signal);
  let failure: unknown;
  for (const [i, p] of order.entries()) {
    // El primero se intenta aunque su disponibilidad no esté clara (la ruta ya comprobó lo que hacía falta); el de respaldo, solo si está listo.
    if (i > 0 && !ready[p]) continue;
    try { return await run(p, AbortSignal.timeout(STT_TIMEOUT_MS)); }
    catch (e) {
      failure = e;
      if (order.slice(i + 1).some(q => ready[q])) console.warn(`transcripción: ${p} falló (${e instanceof Error ? e.message : e}); pruebo el otro proveedor`);
    }
  }
  // Si fallaron todos, el último error dicho en claro (nunca el «motores de IA caídos» de un LlmHttpError ni el detalle crudo).
  if (failure instanceof HttpError) throw failure;
  if (failure instanceof LlmHttpError && failure.status === 429) throw new HttpError(429, 'Gemini limitó la transcripción. Espera un momento.');
  if (failure instanceof LlmHttpError && failure.status) throw new HttpError(502, `Gemini no pudo transcribir (${failure.status}).`);
  throw new HttpError(502, 'La transcripción no respondió a tiempo.');
}
