/**
 * Cola de lectura por trozos con prefetch: mientras suena un trozo ya se están sintetizando los siguientes,
 * y `cancel()` corta TODO de inmediato (lo que suena y lo que está en camino). Es lo que hace posible la
 * interrupción (barge-in): en cuanto el usuario habla, la voz de Nyvo se detiene en el siguiente fotograma de audio.
 * Genérica en el audio (T) para poder probarla sin navegador.
 */
export interface Playing { done: Promise<void>; stop: () => void }

export interface SpeechQueueDeps<T> {
  synth: (text: string, signal: AbortSignal) => Promise<T>;
  play: (audio: T) => Playing;
  /** Cuántos trozos se sintetizan por adelantado (respeta el límite de peticiones de voz). */
  prefetch?: number;
}

export interface SpeakHooks { onStart?: () => void; onEnd?: (reason: 'fin' | 'cancelado' | 'error', error?: unknown) => void }

export class SpeechQueue<T> {
  private gen = 0;
  private ctrl: AbortController | null = null;
  private current: Playing | null = null;
  private active = false;
  constructor(private readonly d: SpeechQueueDeps<T>) {}

  get speaking(): boolean { return this.active; }

  /** Lee los trozos en orden. Cancela cualquier lectura anterior. Resuelve cuando termina o se cancela. */
  async speak(chunks: string[], hooks: SpeakHooks = {}): Promise<void> {
    this.cancel();
    if (!chunks.length) { hooks.onEnd?.('fin'); return; }
    const gen = ++this.gen;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.active = true;
    const ahead = Math.max(1, this.d.prefetch ?? 2);
    const pending: Promise<T>[] = [];
    const ensure = (upTo: number) => {
      for (let i = pending.length; i <= Math.min(upTo, chunks.length - 1); i++) {
        const p = this.d.synth(chunks[i]!, ctrl.signal);
        p.catch(() => undefined);   // el error se trata al reproducir ese trozo
        pending.push(p);
      }
    };
    let started = false;
    let failed = 0;
    let lastError: unknown;
    try {
      ensure(ahead - 1);
      for (let i = 0; i < chunks.length; i++) {
        let audio: T;
        try { audio = await pending[i]!; }
        catch (e) {
          if (gen !== this.gen) { hooks.onEnd?.('cancelado'); return; }
          // Un trozo que el proveedor rechaza no debe callar el resto de la respuesta: se salta y se sigue.
          failed++; lastError = e; ensure(i + ahead);
          continue;
        }
        if (gen !== this.gen) { hooks.onEnd?.('cancelado'); return; }
        ensure(i + ahead);   // al empezar este trozo se piden los siguientes
        if (!started) { started = true; hooks.onStart?.(); }
        const playing = this.d.play(audio);
        this.current = playing;
        await playing.done;
        this.current = null;
        if (gen !== this.gen) { hooks.onEnd?.('cancelado'); return; }
      }
      if (failed && !started) hooks.onEnd?.('error', lastError);   // no sonó nada: ahora sí es un error
      else hooks.onEnd?.('fin');
    } catch (e) {
      hooks.onEnd?.(gen !== this.gen ? 'cancelado' : 'error', gen !== this.gen ? undefined : e);
    } finally {
      if (gen === this.gen) { this.active = false; this.ctrl = null; this.current = null; }
    }
  }

  /** Corta ya: detiene lo que suena y aborta las síntesis en curso. */
  cancel(): void {
    this.gen++;
    this.ctrl?.abort();
    this.ctrl = null;
    const c = this.current;
    this.current = null;
    this.active = false;
    c?.stop();
  }
}
