import { SpeechQueue, type Playing } from './speechQueue';
import { pickSpanishVoice } from './voicePick';

export const browserVoiceSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

/** Espera a que el navegador cargue sus voces (en Chrome llegan tarde, con «voiceschanged»), con un máximo. */
function loadVoices(maxMs = 1500): Promise<SpeechSynthesisVoice[]> {
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
 * Reproductor con la síntesis del propio navegador: elige sola la mejor voz en español y devuelve cada frase como una
 * reproducción que se puede cortar al instante. No hay audio que medir, así que el nivel para animar el orbe se simula con los
 * pulsos de cada palabra que avisa el navegador. Lo usan la voz del navegador y el respaldo cuando falla la del servidor.
 */
export function createBrowserPlayer() {
  const synth = window.speechSynthesis;
  let voice: SpeechSynthesisVoice | null | undefined;   // undefined = aún sin elegir
  let pulse = 0;
  let last = 0;

  return {
    /** Prepara la frase (elige la voz la primera vez). */
    async prepare(text: string): Promise<string> {
      if (voice === undefined) voice = pickSpanishVoice(await loadVoices(), navigator.language);
      return text;
    },
    play(text: string): Playing {
      let finish: () => void = () => undefined;
      const done = new Promise<void>(r => { finish = r; });
      const u = new SpeechSynthesisUtterance(text);
      u.lang = voice?.lang ?? 'es-MX';
      if (voice) u.voice = voice;
      u.rate = 1.02;
      let started = false;
      const guard = setTimeout(() => { if (!started) { synth.cancel(); finish(); } }, START_TIMEOUT_MS);
      u.onstart = () => { started = true; clearTimeout(guard); };
      u.onboundary = () => { pulse = 1; };
      u.onend = () => { clearTimeout(guard); finish(); };
      u.onerror = () => { clearTimeout(guard); finish(); };
      synth.speak(u);
      return { done, stop: () => { clearTimeout(guard); u.onend = null; u.onerror = null; synth.cancel(); finish(); } };
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
export function createBrowserSpeaker() {
  const player = createBrowserPlayer();
  const queue = new SpeechQueue<string>({ prefetch: 1, synth: text => player.prepare(text), play: text => player.play(text) });
  return { queue, level: () => player.level(queue.speaking) };
}

/** Lee un texto una sola vez con la voz del navegador (respaldo de la lectura suelta). Resuelve al terminar. */
export async function speakInBrowser(text: string, onStart?: () => void): Promise<void> {
  const player = createBrowserPlayer();
  const prepared = await player.prepare(text);
  onStart?.();
  await player.play(prepared).done;
}
