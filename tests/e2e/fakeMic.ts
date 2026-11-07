import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * WAV para el micrófono falso de Chromium (--use-file-for-fake-audio-capture). Línea de tiempo (s):
 *   0–1.6  ruido de fondo muy bajo (el VAD calibra)
 *   1.6–3.1  «frase 1» (tono modulado, fuerte)
 *   3.1–7.4  silencio: el servidor transcribe, responde y la voz de Nyvo empieza a sonar
 *   7.4–8.9  «frase 2»: cae encima de la voz de Nyvo → debe interrumpirla (barge-in)
 *   8.9–16  silencio
 */
export function writeFakeMic(path: string): void {
  const rate = 48000;
  const total = 16;
  const data = new Int16Array(rate * total);
  let seed = 1;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    let v = noise() * 0.006;
    const burst = (t >= 1.6 && t < 3.1) || (t >= 7.4 && t < 8.9);
    if (burst) v += (0.22 + 0.1 * Math.sin(2 * Math.PI * 3.2 * t)) * Math.sin(2 * Math.PI * 190 * t) + 0.08 * Math.sin(2 * Math.PI * 540 * t);
    data[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  }
  const buf = Buffer.alloc(44 + data.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(data.length * 2, 40);
  Buffer.from(data.buffer).copy(buf, 44);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}
