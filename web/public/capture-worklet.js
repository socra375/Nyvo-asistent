// AudioWorklet de captura: agrupa los bloques de 128 muestras en bloques de ~1024 y los envía al hilo principal.
// Va como archivo propio del mismo origen (la política de seguridad no permite scripts en línea ni blob:).
class NyvoCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('nyvo-capture', NyvoCapture);
