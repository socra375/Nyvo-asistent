import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, HEMISPHERES, streamChat, type Card, type Hemisphere, type VoiceConfig } from '../lib/api';
import { Vad } from './vad';
import { bytesToBase64, concat, downsample, encodeWav, PreRoll, rms } from './wav';
import { chunkForSpeech } from './chunker';
import { stepConversation, type ConvAction, type ConvEvent, type ConvState } from './conversation';
import { openMic, type Mic } from './capture';
import { createSpeaker } from './speaker';

export type OrbState = 'reposo' | 'escuchando' | 'pensando' | 'hablando';
export type SectionState = 'reposo' | 'activo' | 'listo';
const STT_RATE = 16_000;
const MAX_UTTERANCE_MS = 30_000;
const READY_FADE_MS = 2500;
const MIN_ACTIVE_MS = 450;

export interface OrbVoice {
  /** Estado que muestra el orbe. */
  state: OrbState;
  sections: Record<Hemisphere, SectionState>;
  /** Lo último que dijo el usuario y lo último que respondió Nyvo (subtítulos). */
  heard: string;
  reply: string;
  cards: Card[];
  setCards: (fn: (c: Card[]) => Card[]) => void;
  error: string | null;
  voiceReady: boolean;
  sttReady: boolean;
  /** Micrófono abierto (conversación manos libres activa). */
  live: boolean;
  /** Nivel de audio actual 0..1 (micrófono o voz de Nyvo), para animar sin re-renderizar. */
  getLevel: () => number;
  toggle: () => void;
  sendText: (text: string) => void;
  stopSpeaking: () => void;
  onActivity: () => void;
}

const idleSections = (): Record<Hemisphere, SectionState> => ({ rose: 'reposo', johan: 'reposo', mia: 'reposo', nyvo: 'reposo' });

/** Conversación manos libres con Nyvo: escucha continua con VAD, STT en el servidor, respuesta en vivo y voz que se puede interrumpir. */
export function useOrbVoice(onActivity: () => void, notify: (m: string, err?: boolean) => void): OrbVoice {
  const [conv, setConv] = useState<ConvState>('inactivo');
  const [textBusy, setTextBusy] = useState(false);
  const [sections, setSections] = useState(idleSections);
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [cards, setCardsState] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceConfig | null>(null);

  const convRef = useRef<ConvState>('inactivo');
  const voiceRef = useRef<VoiceConfig | null>(null);
  const convId = useRef<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const micRef = useRef<Mic | null>(null);
  const speakerRef = useRef<ReturnType<typeof createSpeaker> | null>(null);
  const vad = useRef(new Vad());
  const preroll = useRef<PreRoll | null>(null);
  const utter = useRef<Float32Array[]>([]);
  const turn = useRef(0);                       // identifica la petición vigente: las anteriores se descartan
  const abort = useRef<AbortController | null>(null);
  const level = useRef(0);
  const fade = useRef<Partial<Record<Hemisphere, ReturnType<typeof setTimeout>>>>({});
  const activity = useRef(onActivity);
  const notifyRef = useRef(notify);
  useEffect(() => { activity.current = onActivity; notifyRef.current = notify; }, [onActivity, notify]);
  useEffect(() => { voiceRef.current = voice; }, [voice]);
  useEffect(() => { void api<VoiceConfig>('/api/voice/config').then(setVoice).catch(() => undefined); }, []);

  const since = useRef<Partial<Record<Hemisphere, number>>>({});
  const mark = useCallback((id: Hemisphere, s: SectionState) => {
    clearTimeout(fade.current[id]);
    if (s === 'activo') { since.current[id] = performance.now(); setSections(p => ({ ...p, [id]: 'activo' })); return; }
    // Una herramienta rápida no debe parpadear: la sección se ve «activa» al menos MIN_ACTIVE_MS antes de pasar a «lista».
    const wait = Math.max(0, MIN_ACTIVE_MS - (performance.now() - (since.current[id] ?? 0)));
    fade.current[id] = setTimeout(() => {
      setSections(p => ({ ...p, [id]: 'listo' }));
      fade.current[id] = setTimeout(() => setSections(p => ({ ...p, [id]: 'reposo' })), READY_FADE_MS);
    }, wait);
  }, []);
  const clearSections = useCallback(() => {
    HEMISPHERES.forEach(h => clearTimeout(fade.current[h]));
    setSections(idleSections());
  }, []);

  // ───── acciones de la máquina de estados ─────
  const closeMic = useCallback(() => {
    micRef.current?.stop(); micRef.current = null;
    void ctxRef.current?.close().catch(() => undefined); ctxRef.current = null; speakerRef.current = null;
    preroll.current = null; utter.current = []; vad.current.reset(); level.current = 0;
  }, []);

  const run = useCallback((actions: ConvAction[]) => {
    for (const a of actions) {
      if (a === 'cortar-voz') speakerRef.current?.queue.cancel();
      else if (a === 'cancelar-peticion') { turn.current++; abort.current?.abort(); abort.current = null; clearSections(); }
      else if (a === 'cerrar-microfono') closeMic();
      else if (a === 'empezar-frase') { turn.current++; abort.current?.abort(); abort.current = null; utter.current = preroll.current?.take() ?? []; }
    }
  }, [clearSections, closeMic]);

  const dispatch = useCallback((e: ConvEvent) => {
    const s = stepConversation(convRef.current, e);
    convRef.current = s.state;
    setConv(s.state);
    run(s.actions);
  }, [run]);

  // ───── envío al chat y lectura de la respuesta ─────
  const converse = useCallback(async (message: string, spoken: boolean) => {
    const mine = ++turn.current;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setHeard(message); setError(null);
    try {
      const fin = await streamChat({ message, conversationId: convId.current, voice: spoken }, e => {
        if (mine === turn.current && e.tipo === 'hemisferio') mark(e.id, e.estado);
      }, ctrl.signal);
      if (mine !== turn.current) return;
      convId.current = fin.conversationId;
      setReply(fin.reply);
      setCardsState(c => [...c.filter(x => !fin.cards.some(y => y.id === x.id)), ...fin.cards]);
      activity.current();
      const v = voiceRef.current;
      const canSpeak = spoken && !!v && !v.missingEnv.length && !!speakerRef.current;
      // Las secciones que trabajaron quedan en «listo» y se apagan solas (READY_FADE_MS).
      if (!spoken) { setTextBusy(false); return; }
      dispatch({ tipo: 'respuesta-lista', hayVoz: canSpeak });
      if (!canSpeak) return;
      const speaker = speakerRef.current!;
      await speaker.queue.speak(chunkForSpeech(fin.reply.slice(0, v!.maxChars)), {
        onEnd: (why, err) => {
          if (why === 'fin' && mine === turn.current) dispatch({ tipo: 'voz-termina' });
          if (why === 'error') { setError(err instanceof Error ? err.message : 'No se pudo leer la respuesta.'); if (mine === turn.current) dispatch({ tipo: 'voz-termina' }); }
        }
      });
    } catch (e) {
      if (ctrl.signal.aborted || mine !== turn.current) return;
      const msg = e instanceof ApiError || e instanceof Error ? e.message : String(e);
      setError(msg); notifyRef.current(msg, true); setTextBusy(false); clearSections();
      dispatch({ tipo: 'error' });
    }
  }, [mark, clearSections, dispatch]);

  const transcribe = useCallback(async (blocks: Float32Array[], rate: number) => {
    const mine = turn.current;
    try {
      const pcm = downsample(concat(blocks), rate, STT_RATE);
      const res = await fetch('/api/voice/stt', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: bytesToBase64(encodeWav(pcm, STT_RATE)), mimeType: 'audio/wav' }),
        signal: abort.current?.signal
      });
      const j = await res.json() as { text?: string; error?: string };
      if (mine !== turn.current) return;
      if (!res.ok) throw new Error(j.error ?? 'No se pudo transcribir.');
      const text = (j.text ?? '').trim();
      if (!text) { dispatch({ tipo: 'sin-texto' }); return; }
      await converse(text, true);
    } catch (e) {
      if (mine !== turn.current || (e instanceof DOMException && e.name === 'AbortError')) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg); notifyRef.current(msg, true);
      dispatch({ tipo: 'error' });
    }
  }, [converse, dispatch]);

  // ───── bucle de audio: VAD, pre-roll, interrupción ─────
  const onBlock = useCallback((block: Float32Array) => {
    const mic = micRef.current;
    if (!mic || convRef.current === 'inactivo') return;
    const v = vad.current;
    const dt = (block.length / mic.rate) * 1000;
    const e = rms(block);
    const speaking = speakerRef.current?.queue.speaking ?? false;
    level.current = speaking ? speakerRef.current!.level() : Math.min(1, e * 6);
    const ev = v.feed(e, dt, speaking);
    if (ev === 'start') {
      dispatch({ tipo: 'voz-inicia', interrumpe: v.barged });   // 'empezar-frase' recoge el pre-roll
      utter.current.push(block);
      return;
    }
    if (v.inSpeech) {
      utter.current.push(block);
      if (v.speechMs > MAX_UTTERANCE_MS) { v.reset(); const b = utter.current; utter.current = []; dispatch({ tipo: 'frase-lista' }); void transcribe(b, mic.rate); }
      return;
    }
    if (ev === 'end') {
      const b = utter.current;
      utter.current = [];
      if (v.wasSpeech && b.length) { dispatch({ tipo: 'frase-lista' }); void transcribe(b, mic.rate); }
      else preroll.current?.push(block);
      return;
    }
    preroll.current?.push(block);
  }, [dispatch, transcribe]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.resume();
      ctxRef.current = ctx;
      speakerRef.current = createSpeaker(ctx);
      preroll.current = new PreRoll(Math.round(ctx.sampleRate * 0.5));
      vad.current = new Vad();   // nueva calibración del ruido de fondo
      micRef.current = await openMic(ctx, onBlock);
      dispatch({ tipo: 'activar' });
    } catch (e) {
      closeMic();
      const msg = e instanceof Error && e.name === 'NotAllowedError' ? 'El navegador no permite usar el micrófono.' : e instanceof Error ? e.message : 'No se pudo abrir el micrófono.';
      setError(msg); notifyRef.current(msg, true);
    }
  }, [onBlock, dispatch, closeMic]);

  const toggle = useCallback(() => {
    if (convRef.current === 'inactivo') void start();
    else dispatch({ tipo: 'desactivar' });
  }, [start, dispatch]);

  const sendText = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    // Si la conversación por voz está activa, la respuesta también se lee; si no, solo se muestra.
    const spoken = convRef.current !== 'inactivo';
    if (spoken) { speakerRef.current?.queue.cancel(); dispatch({ tipo: 'voz-inicia', interrumpe: false }); dispatch({ tipo: 'frase-lista' }); }
    else setTextBusy(true);
    void converse(t, spoken);
  }, [converse, dispatch]);

  const stopSpeaking = useCallback(() => {
    if (convRef.current === 'hablando') { speakerRef.current?.queue.cancel(); dispatch({ tipo: 'voz-termina' }); }
  }, [dispatch]);

  useEffect(() => () => { turn.current++; abort.current?.abort(); speakerRef.current?.queue.cancel(); closeMic(); HEMISPHERES.forEach(h => clearTimeout(fade.current[h])); }, [closeMic]);

  const state: OrbState = conv !== 'inactivo' ? conv : textBusy ? 'pensando' : 'reposo';
  const setCards = useCallback((fn: (c: Card[]) => Card[]) => setCardsState(fn), []);
  const getLevel = useCallback(() => level.current, []);

  return useMemo(() => ({
    state, sections, heard, reply, cards, setCards, error, getLevel, toggle, sendText, stopSpeaking,
    voiceReady: !!voice && !voice.missingEnv.length, sttReady: !!voice?.stt, live: conv !== 'inactivo', onActivity
  }), [state, sections, heard, reply, cards, setCards, error, getLevel, toggle, sendText, stopSpeaking, voice, conv, onActivity]);
}
