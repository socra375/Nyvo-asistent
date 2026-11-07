/** Micrófono → bloques de audio (AudioWorklet), con cancelación de eco: imprescindible para poder interrumpir a Nyvo sin que se oiga a sí mismo. */
export interface Mic { ctx: AudioContext; rate: number; stop: () => void }

export async function openMic(ctx: AudioContext, onBlock: (b: Float32Array) => void): Promise<Mic> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar el micrófono.');
  if (!ctx.audioWorklet) throw new Error('Este navegador no admite captura de audio en tiempo real.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  });
  try {
    await ctx.audioWorklet.addModule('/capture-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'nyvo-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = e => onBlock(e.data as Float32Array);
    // Algunos navegadores solo procesan el worklet si está conectado a la salida: se conecta en silencio.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    return {
      ctx, rate: ctx.sampleRate,
      stop: () => { node.port.onmessage = null; src.disconnect(); node.disconnect(); mute.disconnect(); stream.getTracks().forEach(t => t.stop()); }
    };
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    throw e;
  }
}
