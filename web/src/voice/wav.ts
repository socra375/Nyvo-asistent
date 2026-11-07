/** Utilidades de audio puras: energía, remuestreo a 16 kHz y WAV de 16 bits (lo que entiende el reconocedor del servidor). */

export function rms(block: Float32Array): number {
  let s = 0;
  for (let i = 0; i < block.length; i++) s += block[i]! * block[i]!;
  return block.length ? Math.sqrt(s / block.length) : 0;
}

/** Remuestrea promediando (filtro de caja): suficiente para voz y barato en tiempo real. */
export function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export function concat(blocks: Float32Array[]): Float32Array {
  const out = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

/** WAV PCM de 16 bits, mono. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(44 + samples.length * 2));
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Anillo de pre-grabación: conserva el último trozo de audio para no perder el comienzo de la frase (el VAD tarda en decidir). */
export class PreRoll {
  private blocks: Float32Array[] = [];
  private samples = 0;
  constructor(private readonly maxSamples: number) {}
  push(b: Float32Array): void {
    this.blocks.push(b); this.samples += b.length;
    while (this.samples - this.blocks[0]!.length >= this.maxSamples) this.samples -= this.blocks.shift()!.length;
  }
  take(): Float32Array[] { const b = this.blocks; this.blocks = []; this.samples = 0; return b; }
}
