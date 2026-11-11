import { SpeechQueue, type Playing } from './speechQueue';
import { rms } from './wav';
import { browserVoiceSupported, createBrowserPlayer } from './browserVoice';
import { createFallback, isVoiceProviderFault } from './fallback';

/** Una frase lista para sonar: audio del servidor, o texto para la voz del navegador cuando el servidor falló. */
type Piece = { kind: 'audio'; buffer: AudioBuffer } | { kind: 'browser'; text: string };

/** Tras un fallo del proveedor de voz del servidor, se usa la del navegador este tiempo antes de volver a intentarlo. */
const SERVER_COOLDOWN_MS = 60_000;

/**
 * Voz de Nyvo: síntesis en el servidor (/api/voice/tts) y reproducción con Web Audio, que se puede cortar al instante.
 * Si el servidor no puede hablar (cuota agotada, caída, red), la frase se lee con la voz del navegador en vez de quedarse mudo.
 */
export function createSpeaker(ctx: AudioContext, opts: { onFallback?: (reason: string) => void } = {}) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(ctx.destination);
  const data = new Float32Array(analyser.fftSize);
  const browser = browserVoiceSupported() ? createBrowserPlayer() : null;

  async function synthServer(text: string, signal: AbortSignal): Promise<Piece> {
    const res = await fetch('/api/voice/tts', {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      throw Object.assign(new Error(j.error ?? 'No se pudo generar la voz.'), { status: res.status });
    }
    return { kind: 'audio', buffer: await ctx.decodeAudioData(await res.arrayBuffer()) };
  }

  const synth = browser
    ? (() => {
        const withFallback = createFallback<Piece, Piece>({
          primary: synthServer,
          fallback: async text => ({ kind: 'browser', text: await browser.prepare(text) }),
          cooldownMs: SERVER_COOLDOWN_MS, isProviderFault: isVoiceProviderFault, onFallback: opts.onFallback
        });
        return async (text: string, signal: AbortSignal) => (await withFallback(text, signal)).value;
      })()
    : synthServer;

  function playBuffer(buffer: AudioBuffer): Playing {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser);
    let finish: () => void = () => undefined;
    const done = new Promise<void>(r => { finish = r; });
    src.onended = () => finish();
    src.start();
    return { done, stop: () => { src.onended = null; try { src.stop(); } catch { /* ya terminó */ } src.disconnect(); finish(); } };
  }

  let usingBrowser = false;
  const queue = new SpeechQueue<Piece>({
    prefetch: 2,
    synth,
    play(piece) {
      usingBrowser = piece.kind === 'browser';
      return piece.kind === 'audio' ? playBuffer(piece.buffer) : browser!.play(piece.text);
    }
  });

  return {
    queue,
    /** Nivel de la voz que suena ahora (0..1) para animar el orbe. */
    level(): number {
      if (usingBrowser && queue.speaking) return browser!.level(true);
      analyser.getFloatTimeDomainData(data);
      return Math.min(1, rms(data) * 3.2);
    }
  };
}
