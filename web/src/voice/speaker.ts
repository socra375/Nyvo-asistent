import { SpeechQueue } from './speechQueue';
import { rms } from './wav';

/** Voz de Nyvo: síntesis en el servidor (/api/voice/tts) y reproducción con Web Audio, que se puede cortar al instante. */
export function createSpeaker(ctx: AudioContext) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(ctx.destination);
  const data = new Float32Array(analyser.fftSize);

  const queue = new SpeechQueue<AudioBuffer>({
    prefetch: 2,
    async synth(text, signal) {
      const res = await fetch('/api/voice/tts', {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? 'No se pudo generar la voz.');
      }
      return await ctx.decodeAudioData(await res.arrayBuffer());
    },
    play(buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(analyser);
      let finish: () => void = () => undefined;
      const done = new Promise<void>(r => { finish = r; });
      src.onended = () => finish();
      src.start();
      return { done, stop: () => { src.onended = null; try { src.stop(); } catch { /* ya terminó */ } src.disconnect(); finish(); } };
    }
  });

  return {
    queue,
    /** Nivel de la voz que suena ahora (0..1) para animar el orbe. */
    level(): number { analyser.getFloatTimeDomainData(data); return Math.min(1, rms(data) * 3.2); }
  };
}
