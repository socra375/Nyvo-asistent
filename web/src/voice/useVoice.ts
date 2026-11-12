import { useCallback, useEffect, useRef, useState } from 'react';
import { WakeWordGate } from './wakeword';
import { browserVoiceSupported, speakWithBrowser } from './browserVoice';
import { effectiveEngine, loadPrefs, type VoicePrefs } from './voicePrefs';

const MAX_RECORD_MS = 15_000;

interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
type SRCtor = new () => SpeechRecognitionLike;
const getSR = (): SRCtor | null => {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
export const wakeWordSupported = () => typeof window !== 'undefined' && getSR() !== null;

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Grabación (pulsar para hablar), transcripción en el servidor y reproducción de la voz de Nyvo. */
export function useRecorder(onError: (m: string) => void) {
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(async (): Promise<Promise<string>> => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m)) ?? '';
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.current = r;
    const done = new Promise<string>((resolve, reject) => {
      r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      r.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setRecording(false);
        if (timer.current) clearTimeout(timer.current);
        try {
          const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
          if (!blob.size) return resolve('');
          const res = await fetch('/api/voice/stt', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: await blobToBase64(blob), mimeType: blob.type })
          });
          const j = await res.json() as { text?: string; error?: string };
          if (!res.ok) throw new Error(j.error ?? 'No se pudo transcribir.');
          resolve(j.text ?? '');
        } catch (e) { reject(e); }
      };
    });
    r.start();
    setRecording(true);
    timer.current = setTimeout(() => { if (r.state === 'recording') r.stop(); }, MAX_RECORD_MS);
    return done;
  }, []);

  const stop = useCallback(() => { if (rec.current?.state === 'recording') rec.current.stop(); }, []);
  useEffect(() => () => { stop(); }, [stop]);
  return { recording, start, stop, onError };
}

/**
 * Lee un texto con la voz que el dueño eligió: la del navegador/PC (o la de Nyvo configurada en el servidor, si es la elegida);
 * si el servidor no puede hablar, con la del navegador.
 */
export async function speak(text: string, onStart?: () => void, provider?: string, prefs: VoicePrefs = loadPrefs()): Promise<void> {
  const browser = { voiceURI: prefs.browserURI, rate: prefs.rate, volume: prefs.volume };
  if (effectiveEngine(provider, prefs) === 'navegador') return speakWithBrowser(text, onStart, browser);
  let res: Response | null = null;
  let failure = 'No se pudo generar la voz.';
  try {
    res = await fetch('/api/voice/tts', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(prefs.serverVoice ? { voice: prefs.serverVoice } : {}) })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      failure = j.error ?? failure;
      res = null;
    }
  } catch (e) { failure = e instanceof Error ? e.message : failure; }
  if (!res) {
    if (!browserVoiceSupported()) throw new Error(failure);
    return speakWithBrowser(text, onStart, browser);
  }
  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  audio.volume = prefs.volume;
  onStart?.();
  await new Promise<void>(resolve => {
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => resolve());
  });
  URL.revokeObjectURL(url);
}

/**
 * Escucha la palabra clave «Oye Nyvo» con el reconocedor del navegador (solo con la pestaña abierta).
 * Apagado por defecto. Al detectarla llama a onWake con lo que se dijo después.
 */
export function useWakeWord(enabled: boolean, paused: boolean, onWake: (command: string) => void) {
  const [error, setError] = useState<string | null>(null);
  const wakeRef = useRef(onWake);
  // La espera entre activaciones sobrevive a los reinicios de la escucha (p. ej. tras cancelar).
  const gateRef = useRef(new WakeWordGate(5000));
  useEffect(() => { wakeRef.current = onWake; }, [onWake]);

  useEffect(() => {
    const SR = getSR();
    if (!enabled || paused || !SR) return;
    const gate = gateRef.current;
    const r = new SR();
    r.lang = 'es-ES';
    r.continuous = true;
    r.interimResults = false;
    let alive = true;
    r.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (!res.isFinal) continue;
        const m = gate.check(res[0]!.transcript);
        if (m.matched) wakeRef.current(m.command);
      }
    };
    // Errores que no se arreglan reintentando: se apaga la escucha y se avisa (sin bucles de reinicio).
    const FATAL: Record<string, string> = {
      'not-allowed': 'El navegador no permite usar el micrófono.',
      'service-not-allowed': 'El reconocimiento de voz del navegador no está disponible.',
      'audio-capture': 'No se encontró un micrófono.',
      network: 'El reconocimiento de voz del navegador necesita conexión.'
    };
    r.onerror = e => { const m = FATAL[e.error]; if (m) { alive = false; setError(m); } };
    r.onend = () => { if (alive) { try { r.start(); } catch { /* ya iniciado */ } } };
    try { r.start(); setError(null); } catch { /* ya iniciado */ }
    return () => { alive = false; r.onend = null; r.abort(); };
  }, [enabled, paused]);

  return { error };
}
