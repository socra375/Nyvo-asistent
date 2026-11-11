import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, fmtDate, type Card, type Conversation, type Message, type VoiceConfig } from '../lib/api';
import { Panel } from '../hud/Panel';
import type { CoreState } from '../hud/Core';
import { speak, useRecorder, useWakeWord, wakeWordSupported } from '../voice/useVoice';

const STATUS_TEXT: Record<Card['status'], string> = {
  pending: 'Pendiente de confirmación', running: 'Ejecutando…', done: 'Hecho', cancelled: 'Cancelada',
  expired: 'Caducó', failed: 'Falló', undone: 'Deshecha'
};

export function ActionCard({ card, onChange }: { card: Card; onChange: (c: Card) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (verb: 'confirm' | 'cancel' | 'undo') => {
    setBusy(true); setErr(null);
    try { onChange((await api<{ card: Card }>(`/api/actions/${card.id}/${verb}`, { method: 'POST' })).card); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const isUndo = card.kind === 'undo';
  const closed = !['pending', 'done'].includes(card.status) || (!isUndo && card.status === 'done');
  return (
    <div className={`card ${isUndo ? 'undo' : ''} ${closed ? 'closed' : ''}`} data-testid="action-card" data-status={card.status} role="group" aria-label={card.summary}>
      <div className="card-head">
        <span className="card-title">{isUndo ? 'Hecho automáticamente' : 'Requiere tu confirmación'}</span>
        <span className={`badge ${card.status}`}>{STATUS_TEXT[card.status]}</span>
      </div>
      <p>{card.summary}</p>
      <details>
        <summary>Detalles ({card.connector_id} · {card.tool})</summary>
        <pre>{JSON.stringify(card.args, null, 2)}</pre>
      </details>
      {card.error && <p className="err">{card.error}</p>}
      {err && <p className="err" role="alert">{err}</p>}
      <div className="card-actions">
        {!isUndo && card.status === 'pending' && <>
          <button type="button" className="btn primary small" disabled={busy} onClick={() => act('confirm')}>Confirmar</button>
          <button type="button" className="btn small" disabled={busy} onClick={() => act('cancel')}>Cancelar</button>
        </>}
        {isUndo && card.status === 'done' && <button type="button" className="btn small" disabled={busy} onClick={() => act('undo')}>Deshacer</button>}
      </div>
    </div>
  );
}

interface Props {
  setCore: (s: CoreState) => void;
  onActivity: () => void;
  notify: (m: string, err?: boolean) => void;
  refreshKey: number;
}

export function Chat({ setCore, onActivity, notify, refreshKey }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [voice, setVoice] = useState<VoiceConfig | null>(null);
  const [readAloud, setReadAloud] = useState(false);
  const [wakeOn, setWakeOn] = useState(false);
  const [wakePrompt, setWakePrompt] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const recorder = useRecorder(m => notify(m, true));

  const loadConversations = useCallback(async () => {
    setConversations((await api<{ conversations: Conversation[] }>('/api/conversations')).conversations);
  }, []);
  const loadMessages = useCallback(async (id: string) => {
    const r = await api<{ messages: Message[]; cards: Card[] }>(`/api/conversations/${id}/messages`);
    setMessages(r.messages);
    setCards(Object.fromEntries(r.cards.map(c => [c.id, c])));
  }, []);

  useEffect(() => { void loadConversations(); void api<VoiceConfig>('/api/voice/config').then(setVoice).catch(() => undefined); }, [loadConversations]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages, cards]);
  // Recarga la conversación abierta cuando hay actividad (p. ej. terminó un trabajo en segundo plano).
  useEffect(() => { if (convId && !sending) void loadMessages(convId).catch(() => undefined); }, [refreshKey, convId, sending, loadMessages]);

  const send = useCallback(async (raw: string) => {
    const message = raw.trim();
    if (!message || sending) return;
    setSending(true); setText(''); setCore('pensando');
    const optimistic: Message = { id: `tmp-${Date.now()}`, role: 'user', content: message, card_ids: [], created_at: new Date().toISOString() };
    setMessages(m => [...m, optimistic]);
    try {
      const r = await api<{ conversationId: string; reply: string; cards: Card[]; jobIds: string[] }>('/api/chat', { method: 'POST', body: { conversationId: convId, message } });
      if (r.conversationId !== convId) { setConvId(r.conversationId); void loadConversations(); }
      setMessages(m => [...m, { id: `a-${Date.now()}`, role: 'assistant', content: r.reply, card_ids: r.cards.map(c => c.id), created_at: new Date().toISOString() }]);
      setCards(c => ({ ...c, ...Object.fromEntries(r.cards.map(x => [x.id, x])) }));
      onActivity();
      if (readAloud && voice && !voice.missingEnv.length) {
        try { await speak(r.reply.slice(0, voice.maxChars), () => setCore('hablando'), voice.provider); }
        catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
      }
    } catch (e) {
      setMessages(m => m.filter(x => x.id !== optimistic.id));
      setText(message);
      notify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSending(false); setCore('reposo');
    }
  }, [convId, sending, readAloud, voice, setCore, onActivity, notify, loadConversations]);

  const listen = useCallback(async () => {
    if (recorder.recording) { recorder.stop(); return; }
    try {
      setCore('escuchando');
      const pending = await recorder.start();
      const heard = await pending;
      setCore('reposo');
      if (heard) await send(heard);
      else notify('No se entendió el audio. Inténtalo de nuevo.', true);
    } catch (e) {
      setCore('reposo');
      notify(e instanceof Error ? e.message : 'No se pudo usar el micrófono.', true);
    }
  }, [recorder, send, setCore, notify]);

  // Palabra clave: confirmación visual de 2 s (cancelable) antes de escuchar.
  const wake = useWakeWord(wakeOn, sending || recorder.recording || wakePrompt !== null, cmd => setWakePrompt(cmd));
  useEffect(() => {
    if (wakePrompt === null) return;
    const t = setTimeout(() => {
      const cmd = wakePrompt;
      setWakePrompt(null);
      if (cmd) void send(cmd); else void listen();
    }, 2000);
    return () => clearTimeout(t);
  }, [wakePrompt, send, listen]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); }
  };
  const newConversation = () => { setConvId(null); setMessages([]); setCards({}); };
  const pickConversation = (id: string) => { if (!id) return newConversation(); setConvId(id); void loadMessages(id); };

  const voiceReady = voice && !voice.missingEnv.length;
  return (
    <Panel id="panel-chat" title="Conversación" tag="CHAT CON TARJETAS" className="chat" actions={
      <button type="button" className="btn small" onClick={newConversation}>Nueva</button>
    }>
      {messages.length === 0 && (
        <div className="empty" data-testid="chat-empty">
          Pídele algo a Nyvo: «¿Qué clientes tengo?», «Anota que el proveedor sube precios en enero», «Haz un reporte de cobros».
          Toda acción que cambie datos externos te pedirá confirmación en una tarjeta.
        </div>
      )}
      {messages.map(m => (
        <div key={m.id} className="msg-group">
          <div className={`msg ${m.role}`} data-testid={`msg-${m.role}`}>
            <span className="who-l">{m.role === 'user' ? 'Tú' : 'Nyvo'} · {fmtDate(m.created_at)}</span>
            {m.content}
          </div>
          {m.card_ids.map(id => cards[id] && <ActionCard key={id} card={cards[id]!} onChange={c => { setCards(x => ({ ...x, [c.id]: c })); onActivity(); }} />)}
        </div>
      ))}
      {sending && <div className="msg assistant" aria-live="polite"><span className="who-l">Nyvo</span>Pensando…</div>}
      <div ref={bottom} />
      <form className="composer" onSubmit={e => { e.preventDefault(); void send(text); }}>
        <label htmlFor="chat-input" className="sr-only">Mensaje para Nyvo</label>
        <textarea id="chat-input" rows={1} placeholder="Escribe a Nyvo…" value={text} onChange={e => setText(e.target.value)} onKeyDown={onKey} maxLength={4000} />
        <button type="button" className={`btn icon ${recorder.recording ? 'rec' : ''}`} onClick={listen} disabled={sending || !voice?.stt}
          aria-label={recorder.recording ? 'Detener grabación' : 'Hablar con Nyvo'} title={voice?.stt ? 'Pulsa para hablar' : 'Falta configurar la transcripción de voz (GROQ_API_KEY)'}>
          {recorder.recording ? '■' : '🎙'}
        </button>
        <button type="submit" className="btn primary" disabled={sending || !text.trim()}>Enviar</button>
      </form>
      <div className="chat-tools">
        <label htmlFor="conv-select" className="sr-only">Elegir conversación</label>
        <select id="conv-select" value={convId ?? ''} onChange={e => pickConversation(e.target.value)}>
          <option value="">Conversación nueva</option>
          {conversations.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <label className="switch" title={voiceReady ? '' : `Falta configurar: ${voice?.missingEnv.join(', ')}`}>
          <input type="checkbox" checked={readAloud} disabled={!voiceReady} onChange={e => setReadAloud(e.target.checked)} />
          Leer respuestas en voz alta
        </label>
        {wakeWordSupported() && (
          <label className="switch" title="Solo funciona con esta pestaña abierta. Se ignoran palabras parecidas como «nuevo» o «nivel».">
            <input type="checkbox" checked={wakeOn} disabled={!voice?.stt} onChange={e => setWakeOn(e.target.checked)} />
            Palabra clave «{voice?.wakeWord ?? 'Oye Nyvo'}»
          </label>
        )}
        {!voiceReady && voice && <span className="mono">Voz: falta configurar {voice.missingEnv.join(', ')}</span>}
        {wake.error && <span className="err">{wake.error}</span>}
      </div>
      {wakePrompt !== null && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Palabra clave detectada">
          <div className="panel">
            <div className="label">Palabra clave detectada</div>
            <p>{wakePrompt ? `Voy a enviar: «${wakePrompt}»` : 'Te escucho en 2 segundos…'}</p>
            <button type="button" className="btn" onClick={() => setWakePrompt(null)}>Cancelar</button>
          </div>
        </div>
      )}
    </Panel>
  );
}
