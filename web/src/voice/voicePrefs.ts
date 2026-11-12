/**
 * Voz que el dueño eligió para Nyvo (se guarda en este navegador). «auto» sigue lo que tenga configurado el servidor; «navegador»
 * usa una voz de las que ofrece este equipo (las del sistema, instaladas en la PC, y las en línea del navegador); «servidor» usa la
 * voz del servicio (Gemini, ElevenLabs…), con la voz concreta de su lista.
 */
export interface VoicePrefs {
  engine: 'auto' | 'navegador' | 'servidor';
  /** voiceURI de la voz del navegador/PC elegida; null = la mejor en español, elegida sola. */
  browserURI: string | null;
  /** id de la voz del servidor elegida; null = la predeterminada. */
  serverVoice: string | null;
  /** Velocidad de lectura (solo voces del navegador). */
  rate: number;
  volume: number;
}

export const PREFS_KEY = 'nyvo.voz.prefs';
export const RATE_RANGE = { min: 0.7, max: 1.4 } as const;
export const DEFAULT_PREFS: VoicePrefs = { engine: 'auto', browserURI: null, serverVoice: null, rate: 1.02, volume: 1 };

const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);

/** Lo guardado, validado campo a campo: un valor raro o ausente vuelve al predeterminado. */
export function parsePrefs(raw: string | null | undefined): VoicePrefs {
  let j: Record<string, unknown> = {};
  try { const v = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object') j = v as Record<string, unknown>; } catch { /* guardado dañado: se parte de cero */ }
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length < 300 ? v : null);
  return {
    engine: j.engine === 'navegador' || j.engine === 'servidor' ? j.engine : 'auto',
    browserURI: str(j.browserURI),
    serverVoice: str(j.serverVoice),
    rate: clamp(j.rate, RATE_RANGE.min, RATE_RANGE.max, DEFAULT_PREFS.rate),
    volume: clamp(j.volume, 0, 1, DEFAULT_PREFS.volume)
  };
}

export function loadPrefs(): VoicePrefs {
  try { return parsePrefs(window.localStorage.getItem(PREFS_KEY)); } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(p: VoicePrefs): void {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* sin almacenamiento: vale solo esta sesión */ }
}

/**
 * Qué voz suena de verdad: la del navegador si el servidor no tiene voz configurada o si el dueño la eligió; si no, la del servidor.
 * `provider` es el que informa /api/voice/config («navegador» cuando el servidor no tiene ninguna voz propia).
 */
export function effectiveEngine(provider: string | undefined, prefs: VoicePrefs): 'navegador' | 'servidor' {
  if (!provider || provider === 'navegador') return 'navegador';
  return prefs.engine === 'navegador' ? 'navegador' : 'servidor';
}

/** Voces del navegador/PC para elegir: primero las de español, dentro de cada grupo las instaladas en la PC y luego las en línea. */
export interface BrowserVoiceInfo { voiceURI: string; name: string; lang: string; localService: boolean }
export function sortBrowserVoices(voices: readonly BrowserVoiceInfo[]): { spanish: BrowserVoiceInfo[]; other: BrowserVoiceInfo[] } {
  const norm = (l: string) => l.toLowerCase().replace('_', '-');
  const byName = (a: BrowserVoiceInfo, b: BrowserVoiceInfo) => (Number(b.localService) - Number(a.localService)) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name, 'es');
  const spanish = voices.filter(v => norm(v.lang).startsWith('es')).sort(byName);
  const other = voices.filter(v => !norm(v.lang).startsWith('es')).sort(byName);
  return { spanish, other };
}
