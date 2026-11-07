/**
 * Detector de actividad de voz (VAD) por energía, con suelo de ruido adaptativo e histéresis.
 * Pensado para hablar «manos libres»: decide cuándo empieza y termina una frase y, mientras Nyvo habla,
 * cuándo el usuario lo interrumpe (barge-in) sin confundir el propio eco con una voz.
 *
 * Es una función pura del tiempo y la energía (sin audio ni DOM): se prueba con señales sintéticas.
 */
export interface VadOptions {
  /** Energía mínima absoluta (RMS 0..1) para considerar voz. */
  floor: number;
  /** Veces por encima del suelo de ruido para empezar / para seguir en voz (histéresis). */
  onRatio: number;
  offRatio: number;
  /** Voz sostenida necesaria para dar por iniciada una frase. */
  startMs: number;
  /** Silencio que cierra la frase. */
  hangoverMs: number;
  /** Frases más cortas que esto se descartan (golpes, clics). */
  minSpeechMs: number;
  /** Mientras Nyvo habla: umbral multiplicado y voz sostenida más larga para contar como interrupción. */
  bargeRatio: number;
  bargeMs: number;
}

export const VAD_DEFAULTS: VadOptions = {
  floor: 0.012, onRatio: 2.6, offRatio: 1.6, startMs: 90, hangoverMs: 750, minSpeechMs: 260, bargeRatio: 2.4, bargeMs: 170
};

export type VadEvent = 'start' | 'end' | null;

export class Vad {
  noise = 0.004;
  inSpeech = false;
  /** Duración de la frase actual (o de la última terminada) en ms. */
  speechMs = 0;
  /** true si la frase actual empezó mientras Nyvo hablaba (interrupción). */
  barged = false;
  private above = 0;
  private below = 0;
  /** Calibración inicial: al abrir el micrófono se mide el ruido de fondo (sin detectar voz) para no tomar un zumbido constante por una frase. */
  private calibMs = 400;

  constructor(private readonly o: VadOptions = VAD_DEFAULTS) {}

  /** Umbral actual para empezar a considerar voz. */
  threshold(outputPlaying: boolean): number {
    return Math.max(this.o.floor, this.noise * this.o.onRatio) * (outputPlaying ? this.o.bargeRatio : 1);
  }

  reset(): void { this.inSpeech = false; this.speechMs = 0; this.above = 0; this.below = 0; this.barged = false; }

  /** Procesa un bloque de audio: `rms` (0..1), `dtMs` que dura el bloque y si Nyvo está hablando ahora. */
  feed(rms: number, dtMs: number, outputPlaying: boolean): VadEvent {
    if (this.calibMs > 0) {
      this.calibMs -= dtMs;
      this.noise = Math.min(0.05, this.noise * 0.8 + rms * 0.2);
      return null;
    }
    if (!this.inSpeech) {
      // El suelo baja rápido y sube despacio: sigue al ruido de fondo sin tomar la voz por ruido.
      // Un pico fuerte (voz, golpe) casi no mueve el suelo: se limita a la altura del umbral y sube muy despacio.
      const thr = this.threshold(outputPlaying);
      const loud = rms > thr;
      const a = rms < this.noise ? 0.2 : loud ? 0.002 : 0.01;
      this.noise = Math.min(0.05, this.noise * (1 - a) + Math.min(rms, thr) * a);
      if (loud) {
        this.above += dtMs;
        if (this.above >= (outputPlaying ? this.o.bargeMs : this.o.startMs)) {
          this.inSpeech = true; this.speechMs = this.above; this.below = 0; this.barged = outputPlaying;
          return 'start';
        }
      } else this.above = 0;
      return null;
    }
    this.speechMs += dtMs;
    if (rms < Math.max(this.o.floor * 0.7, this.noise * this.o.offRatio)) {
      this.below += dtMs;
      if (this.below >= this.o.hangoverMs) {
        this.inSpeech = false; this.above = 0; this.below = 0;
        return 'end';
      }
    } else this.below = 0;
    return null;
  }

  /** ¿La última frase fue lo bastante larga para ser voz? */
  get wasSpeech(): boolean { return this.speechMs - this.o.hangoverMs >= this.o.minSpeechMs; }
}
