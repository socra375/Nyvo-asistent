import type { Env } from '../config.js';
import type { VoiceProvider } from './tts.js';

/** Una voz que el servidor puede usar para leer las respuestas. */
export interface ServerVoice { id: string; name: string; default?: boolean }

/**
 * Voces predefinidas de Gemini TTS, según su documentación. Cambian con el tiempo y no todas las admite cada modelo de voz:
 * GEMINI_TTS_VOICES (nombres separados por coma) las sustituye. Si una no existe, la voz del navegador toma el relevo.
 */
export const GEMINI_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina',
  'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix',
  'Sadachbia', 'Sadaltager', 'Sulafat'
] as const;

const MAX_VOICES = 40;
const NAME_RE = /^[\p{L}\p{N} ._-]{1,40}$/u;
const GEMINI_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{1,40}$/;
const ELEVEN_ID_RE = /^[A-Za-z0-9]{10,40}$/;

const split = (v: string | undefined) => (v ?? '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean);

/**
 * Voces entre las que se puede elegir con el proveedor de voz del servidor. La predeterminada (GEMINI_TTS_VOICE,
 * ELEVENLABS_VOICE_ID…) va primero. Solo una voz de esta lista llega al proveedor: nadie puede hacer hablar la clave con otra.
 */
export function serverVoices(provider: VoiceProvider, env: Env): ServerVoice[] {
  if (provider === 'gemini') {
    const main = env.GEMINI_TTS_VOICE?.trim();
    const names = split(env.GEMINI_TTS_VOICES).filter(n => GEMINI_ID_RE.test(n));
    const all = [...new Set([...(main ? [main] : []), ...(names.length ? names : GEMINI_VOICES)])].filter(n => GEMINI_ID_RE.test(n)).slice(0, MAX_VOICES);
    return all.map(n => ({ id: n, name: n, ...(n === main || (!main && n === all[0]) ? { default: true } : {}) }));
  }
  if (provider === 'elevenlabs') {
    const main = env.ELEVENLABS_VOICE_ID?.trim();
    const out: ServerVoice[] = main && ELEVEN_ID_RE.test(main) ? [{ id: main, name: 'Voz de Nyvo', default: true }] : [];
    // ELEVENLABS_VOICES = «Nombre:id» separados por coma, punto y coma o salto de línea (el mismo formato que usa Eddie).
    for (const item of split(env.ELEVENLABS_VOICES)) {
      const cut = item.lastIndexOf(':');
      const id = (cut >= 0 ? item.slice(cut + 1) : item).trim();
      const name = (cut >= 0 ? item.slice(0, cut) : '').trim();
      if (!ELEVEN_ID_RE.test(id) || out.some(v => v.id === id)) continue;
      out.push({ id, name: NAME_RE.test(name) ? name : `Voz ${out.length + 1}` });
      if (out.length >= MAX_VOICES) break;
    }
    return out;
  }
  if (provider === 'speechify') {
    const id = env.SPEECHIFY_VOICE_ID?.trim();
    return id ? [{ id, name: 'Voz de Nyvo', default: true }] : [];
  }
  return [];
}

/** La voz pedida si está en la lista; si no, la predeterminada (o ninguna: el proveedor usa la suya). */
export function resolveVoice(provider: VoiceProvider, env: Env, asked: string | undefined): string | undefined {
  const list = serverVoices(provider, env);
  return list.find(v => v.id === asked)?.id ?? list.find(v => v.default)?.id;
}
