import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, type Note, type Style } from '../lib/api';
import { Panel, Skeleton } from '../hud/Panel';

export function MemoryView({ notify }: { notify: (m: string, err?: boolean) => void }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [style, setStyle] = useState<Style>({ description: '', samples: [], updated_at: null });
  const [samplesText, setSamplesText] = useState('');
  const [newNote, setNewNote] = useState('');
  const [confirmWipe, setConfirmWipe] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ notes: Note[]; style: Style }>('/api/memory');
    setNotes(r.notes); setStyle(r.style); setSamplesText(r.style.samples.join('\n---\n'));
  }, []);
  useEffect(() => { void load().catch(e => notify(String(e.message ?? e), true)); }, [load, notify]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); notify(ok); await load(); } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
  };

  return (
    <div className="page">
      <h1>Memoria</h1>
      <p className="intro">Lo que Nyvo recuerda de ti y cómo escribes. Puedes borrarlo o exportarlo cuando quieras. Las notas de negocio que le cuentas se guardan en Notion; aquí van tus preferencias.</p>
      <div className="two-col">
        <Panel id="memoria-notas" title="Notas" tag={notes ? `${notes.length}` : ''}>
          <form className="row" onSubmit={e => { e.preventDefault(); if (newNote.trim()) void run(() => api('/api/memory', { method: 'POST', body: { content: newNote } }).then(() => setNewNote('')), 'Nota guardada.'); }}>
            <label className="sr-only" htmlFor="nueva-nota">Nueva nota</label>
            <input id="nueva-nota" className="search" placeholder="Ej.: Prefiero que los correos sean breves" value={newNote} onChange={e => setNewNote(e.target.value)} maxLength={2000} />
            <button type="submit" className="btn small" disabled={!newNote.trim()}>Añadir</button>
          </form>
          {!notes ? <Skeleton /> : notes.length === 0 ? <div className="empty">Sin notas.</div> : (
            <ul className="list">
              {notes.map(n => (
                <li key={n.id}>
                  <div className="main"><span className="t">{n.content}</span><span className="s">{fmtDate(n.created_at)}{n.tags.length ? ` · ${n.tags.join(', ')}` : ''}</span></div>
                  <button type="button" className="btn small ghost" aria-label={`Borrar nota: ${n.content}`} onClick={() => run(() => api(`/api/memory/${n.id}`, { method: 'DELETE' }), 'Nota borrada.')}>Borrar</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel id="memoria-estilo" title="Estilo de escritura">
          <form onSubmit={e => { e.preventDefault(); void run(() => api('/api/memory/style', { method: 'PUT', body: { description: style.description, samples: samplesText.split(/\n-{3,}\n/) } }), 'Estilo guardado.'); }}>
            <div className="field">
              <label className="label" htmlFor="estilo-desc">Cómo escribes</label>
              <textarea id="estilo-desc" rows={3} placeholder="Ej.: directo, cordial, tuteo, frases cortas, sin emojis" value={style.description} onChange={e => setStyle(s => ({ ...s, description: e.target.value }))} maxLength={2000} />
            </div>
            <div className="field">
              <label className="label" htmlFor="estilo-ejemplos">Ejemplos (hasta 5, separados por una línea con ---)</label>
              <textarea id="estilo-ejemplos" rows={6} value={samplesText} onChange={e => setSamplesText(e.target.value)} />
            </div>
            <p><button type="submit" className="btn small">Guardar estilo</button></p>
          </form>
        </Panel>
      </div>
      <Panel id="memoria-datos" title="Tus datos">
        <div className="row">
          <a className="btn" href="/api/memory/export" download="nyvo-memoria.json">Exportar memoria (JSON)</a>
          {!confirmWipe ? (
            <button type="button" className="btn danger" onClick={() => setConfirmWipe(true)}>Borrar toda la memoria</button>
          ) : (
            <>
              <span>¿Seguro? Se borran todas las notas y el estilo.</span>
              <button type="button" className="btn danger" onClick={() => { setConfirmWipe(false); void run(() => api('/api/memory', { method: 'DELETE' }), 'Memoria borrada.'); }}>Sí, borrar todo</button>
              <button type="button" className="btn" onClick={() => setConfirmWipe(false)}>Cancelar</button>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
