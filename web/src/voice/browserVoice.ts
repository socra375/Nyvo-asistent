import { SpeechQueue, type Playing } from './speechQueue';
import { pickSpanishVoice } from './voicePick';
import { chunkForSpeech } from './chunker';

export const browserVoiceSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

/** Espera a que el navegador cargue sus voces (en Chrome llegan tarde, con «voiceschanged»), con un máximo. */
export function loadVoices(maxMs = 1500): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise(resolve => {
    const done = () => { synth.removeEventListener('voiceschanged', done); clearTimeout(t); resolve(synth.getVoices()); };
    const t = setTimeout(done, maxMs);
    synth.addEventListener('voiceschanged', done);
  });
}

/** Si una frase no empieza a sonar en este tiempo, se da por fallida (algunos navegadores se quedan mudos sin avisar). */
const START_TIMEOUT_MS = 4000;
/**
 * Chrome pierde en silencio la frase que se lanza justo después de `cancel()` (su `onerror` salta con «interrupted» o «canceled»
 * sin haber sonado). Pasaba al llegar la respuesta con la frase de espera aún sonando: la respuesta «se leía» en milisegundos y
 * no se oía nada. Por eso entre un corte y la frase siguiente se deja un hueco, y una frase que no llegó a sonar se repite una vez.
 */
export const CANCEL_GAP_MS = 160;
let lastCancel = -Infinity;
const cancelSpeech = () => { window.speechSynthesis.cancel(); lastCancel = performance.now(); };
/** Ejecuta `go` cuando haya pasado el hueco desde el último corte; devuelve el temporizador si tuvo que esperar. */
const afterGap = (go: () => void): number | undefined => {
  const wait = CANCEL_GAP_MS - (performance.now() - lastCancel);
  if (wait <= 0) { go(); return undefined; }
  return window.setTimeout(go, wait);
};

export interface BrowserVoiceOpts {
  /** voiceURI de la voz elegida en Voces; sin ella, se elige sola la mejor en español. */
  voiceURI?: string | null;
  rate?: number;
  volume?: number;
}

const pickVoice = (all: SpeechSynthesisVoice[], o: BrowserVoiceOpts) =>
  (o.voiceURI ? all.find(v => v.voiceURI === o.voiceURI) : null) ?? pickSpanishVoice(all, navigator.language);

/**
 * Reproductor con la síntesis del propio navegador: elige sola la mejor voz en español (o la que el dueño eligió) y devuelve
 * cada frase como una reproducción que se puede cortar al instante. No hay audio que medir, así que el nivel para animar el
 * orbe se simula con los pulsos de cada palabra que avisa el navegador. Lo usan la voz del navegador y el respaldo cuando
 * falla la del servidor.
 */
export function createBrowserPlayer(o: BrowserVoiceOpts = {}) {
  const rate = o.rate ?? 1.02;
  const volume = o.volume ?? 1;
  let voice: SpeechSynthesisVoice | null | undefined;   // undefined = aún sin elegir
  let pulse = 0;
  let last = 0;

  return {
    /** Prepara la frase (elige la voz la primera vez). */
    async prepare(text: string): Promise<string> {
      if (voice === undefined) voice = pickVoice(await loadVoices(), o);
      return text;
    },
    play(text: string): Playing {
      let stopped = false;
      let current: SpeechSynthesisUtterance | null = null;
      let timer: number | undefined;
      let guard: ReturnType<typeof setTimeout> | undefined;
      const done = new Promise<void>((resolve, reject) => {
        const attempt = (retry: boolean) => {
          const u = new SpeechSynthesisUtterance(text);
          current = u;
          u.lang = voice?.lang ?? 'es-MX';
          if (voice) u.voice = voice;
          u.rate = rate;
          u.volume = volume;
          let started = false;
          // La frase no llegó a sonar: se repite una vez y, si tampoco, se avisa (antes se daba por leída en silencio).
          const failed = () => {
            clearTimeout(guard);
            if (stopped) { resolve(); return; }
            cancelSpeech();
            if (retry) { timer = afterGap(() => { if (stopped) resolve(); else attempt(false); }); return; }
            reject(new Error('La voz del navegador no pudo leer la respuesta (¿hay una voz en español instalada?).'));
          };
          guard = setTimeout(() => { if (!started) failed(); }, START_TIMEOUT_MS);
          u.onstart = () => { started = true; clearTimeout(guard); };
          u.onboundary = () => { pulse = 1; };
          u.onend = () => { clearTimeout(guard); if (!stopped) resolve(); };
          u.onerror = () => { if (started || stopped) { clearTimeout(guard); resolve(); } else failed(); };
          timer = afterGap(() => window.speechSynthesis.speak(u));
        };
        attempt(true);
      });
      return {
        done,
        stop: () => {
          stopped = true; clearTimeout(guard); window.clearTimeout(timer);
          if (current) { current.onend = null; current.onerror = null; }
          cancelSpeech();
        }
      };
    },
    /** Nivel simulado (0..1): sube con cada palabra y baja suave, con un leve latido de fondo mientras habla. */
    level(speaking: boolean): number {
      const t = performance.now();
      const dt = Math.min(0.1, (t - last) / 1000); last = t;
      pulse = Math.max(0, pulse - dt * 4.5);
      return speaking ? Math.min(1, 0.22 + 0.5 * pulse + 0.08 * Math.sin(t / 130)) : 0;
    }
  };
}

/** Voz de Nyvo con la síntesis del propio navegador: sin claves, sin servidor y sin límite de peticiones. Misma interfaz que el altavoz del servidor (cola con corte inmediato). */
export function createBrowserSpeaker(o: BrowserVoiceOpts = {}) {
  const player = createBrowserPlayer(o);
  const queue = new SpeechQueue<string>({ prefetch: 1, synth: text => player.prepare(text), play: text => player.play(text) });
  return { queue, level: () => player.level(queue.speaking) };
}

/**
 * Lee un texto entero con la voz del navegador (la usa el chat del Panel, que no tiene cola de lectura): lo parte en frases
 * cortas, porque Chrome corta las lecturas largas a mitad. Resuelve al terminar; si el navegador no tiene voz, lanza un error
 * claro en vez de quedarse mudo.
 */
export async function speakWithBrowser(text: string, onStart?: () => void, o: BrowserVoiceOpts = {}): Promise<void> {
  if (!browserVoiceSupported()) throw new Error('Tu navegador no tiene voz integrada para leer en voz alta.');
  const synth = window.speechSynthesis;
  const voice = pickVoice(await loadVoices(), o);
  cancelSpeech();
  let started = false;
  for (const chunk of chunkForSpeech(text)) {
    const ok = await new Promise<boolean>(resolve => {
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = voice?.lang ?? 'es-MX';
      if (voice) u.voice = voice;
      u.rate = o.rate ?? 1.02;
      u.volume = o.volume ?? 1;
      let began = false;
      const guard = setTimeout(() => { if (!began) { synth.cancel(); resolve(false); } }, START_TIMEOUT_MS);
      u.onstart = () => { began = true; clearTimeout(guard); if (!started) { started = true; onStart?.(); } };
      u.onend = () => { clearTimeout(guard); resolve(true); };
      u.onerror = () => { clearTimeout(guard); resolve(began); };
      afterGap(() => synth.speak(u));
    });
    if (!ok && !started) throw new Error('El navegador no pudo leer la respuesta en voz alta (¿no tiene una voz en español instalada?).');
  }
}
