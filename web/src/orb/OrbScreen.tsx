import { useEffect, useState, type ReactNode } from 'react';
import { Orb } from './Orb';
import { useOrbVoice } from '../voice/useOrbVoice';
import { Chat, ActionCard } from '../panels/Chat';
import { ClientsPanel, DrivePanel, JobsPanel, NotionPanel } from '../panels/panels';
import { ConnectorsView } from '../panels/Connectors';
import { MemoryView } from '../panels/Memory';
import { Voices } from '../panels/Voices';
import { SECTION_LABEL } from './orbModel';
import type { Job } from '../lib/api';

interface Props {
  onActivity: () => void;
  notify: (m: string, err?: boolean) => void;
  logout: () => void;
  refreshKey: number;
  jobs: Job[] | null;
  jobsActive: number;
  loadJobs: () => Promise<void>;
  runNow: () => Promise<void>;
  /** Tarjeta que se abre al entrar (p. ej. «conectores» al volver de Google). */
  initialOpen?: WinId;
}

export type WinId = 'clientes' | 'archivos' | 'notion' | 'trabajos' | 'conversacion' | 'conectores' | 'memoria' | 'voces';

/** Las tarjetas que se abren sobre el orbe (ya no hay un «panel» aparte): a qué lado van y cómo se llaman en la barra. */
const WINDOWS: { id: WinId; label: string; side: 'izq' | 'der' }[] = [
  { id: 'clientes', label: 'Clientes', side: 'izq' },
  { id: 'trabajos', label: 'Trabajos', side: 'izq' },
  { id: 'conversacion', label: 'Conversación', side: 'izq' },
  { id: 'archivos', label: 'Archivos', side: 'der' },
  { id: 'notion', label: 'Notion', side: 'der' },
  { id: 'conectores', label: 'Conectores', side: 'der' },
  { id: 'memoria', label: 'Memoria', side: 'der' },
  { id: 'voces', label: 'Voces', side: 'der' }
];

const HINT = {
  reposo: 'Toca el orbe para hablar con Nyvo',
  escuchando: 'Te escucho… habla cuando quieras',
  pensando: 'Pensando…',
  hablando: 'Hablando… háblame para interrumpir'
} as const;

const noopCore = () => undefined;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;

/** Una tarjeta flotante sobre el orbe. El contenido pone su propio título; aquí solo el marco de cristal y el cierre. */
function Win({ id, label, onClose, children }: { id: WinId; label: string; onClose: () => void; children: ReactNode }) {
  return (
    <section className="orb-win" data-testid={`win-${id}`} aria-label={label}>
      <button type="button" className="orb-win-close" onClick={onClose} aria-label={`Cerrar ${label}`} title="Cerrar">✕</button>
      {children}
    </section>
  );
}

/** Pantalla única: el orbe, y sobre él las tarjetas (clientes, archivos, conversación, conectores, voces…) que se abren desde la barra. */
export function OrbScreen({ onActivity, notify, logout, refreshKey, jobs, jobsActive, loadJobs, runNow, initialOpen }: Props) {
  const v = useOrbVoice(onActivity, notify);
  const [keyboard, setKeyboard] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [text, setText] = useState('');
  const [connVer, setConnVer] = useState(0);
  const [open, setOpen] = useState<WinId[]>(initialOpen ? [initialOpen] : []);
  const pending = v.cards.filter(c => c.status === 'pending' || (c.kind === 'undo' && c.status === 'done'));
  const busy = v.state === 'pensando';

  const toggle = (id: WinId) => setOpen(o => (o.includes(id) ? o.filter(x => x !== id) : [...o, id]));
  const close = (id: WinId) => setOpen(o => o.filter(x => x !== id));
  const show = (id: WinId) => setOpen(o => (o.includes(id) ? o : [...o, id]));
  // Escape cierra la última tarjeta abierta.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) setOpen(o => o.slice(0, -1)); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const content: Record<WinId, ReactNode> = {
    clientes: <ClientsPanel refreshKey={refreshKey + connVer} goConnectors={() => show('conectores')} />,
    archivos: <DrivePanel refreshKey={refreshKey + connVer} goConnectors={() => show('conectores')} />,
    notion: <NotionPanel refreshKey={refreshKey + connVer} goConnectors={() => show('conectores')} />,
    trabajos: <JobsPanel jobs={jobs} reload={loadJobs} onRunNow={runNow} />,
    conversacion: <Chat setCore={noopCore} onActivity={onActivity} notify={notify} refreshKey={refreshKey} />,
    conectores: <ConnectorsView notify={notify} onChanged={() => setConnVer(n => n + 1)} />,
    memoria: <MemoryView notify={notify} />,
    voces: <Voices config={v.voiceConfig} prefs={v.prefs} setPrefs={v.setPrefs} notify={notify} />
  };
  const column = (side: 'izq' | 'der') => {
    const ids = open.filter(id => WINDOWS.find(w => w.id === id)?.side === side);
    return ids.length ? (
      <div className={`orb-wins ${side}`}>
        {ids.map(id => <Win key={id} id={id} label={WINDOWS.find(w => w.id === id)!.label} onClose={() => close(id)}>{content[id]}</Win>)}
      </div>
    ) : null;
  };

  return (
    <main className="orbscreen" data-testid="orbscreen" data-open={open.join(' ')}>
      <div className="orb-corner tl">
        <img className="orb-logo" src="/logo-96.png" alt="" width={28} height={28} />
        <strong>NYVO</strong>
      </div>
      <nav className="orb-dock" aria-label="Tarjetas">
        {WINDOWS.map(w => (
          <button key={w.id} type="button" className="orb-ctl" aria-pressed={open.includes(w.id)} onClick={() => toggle(w.id)}>
            {w.label}{w.id === 'trabajos' && jobsActive ? <span className="orb-badge" aria-label={`${jobsActive} en curso`}>{jobsActive}</span> : null}
          </button>
        ))}
      </nav>
      <div className="orb-corner tr">
        <button type="button" className="orb-ctl" onClick={logout}>Salir</button>
      </div>

      <button type="button" className="orb-hit" onClick={v.toggle} disabled={!v.sttReady && !v.live}
        aria-pressed={v.live} aria-label={v.live ? 'Detener la conversación por voz' : 'Hablar con Nyvo'}
        title={v.sttReady ? '' : 'Falta configurar la transcripción de voz (GROQ_API_KEY). Puedes escribirle con el teclado.'}>
        <Orb state={v.state} sections={v.sections} getLevel={v.getLevel} />
      </button>

      {open.length > 0 && <div className="orb-wins-layer">{column('izq')}{column('der')}</div>}

      <div className="orb-status" aria-live="polite" data-testid="orb-status">
        {v.state === 'pensando' && v.working ? v.working : v.sttReady || v.live ? HINT[v.state] : 'Voz sin configurar: escríbele a Nyvo con el teclado'}
        {jobsActive ? ` · ${jobsActive} trabajo${jobsActive > 1 ? 's' : ''} en curso` : ''}
      </div>
      {(v.state === 'hablando') && <button type="button" className="orb-ctl stop" onClick={v.stopSpeaking}>Callar</button>}

      {captions && (v.heard || v.reply) && (
        <div className="orb-captions" data-testid="captions">
          {v.heard && <p className="heard"><span>Tú</span>{v.heard}</p>}
          {v.reply && <p className="said"><span>Nyvo</span>{v.reply}</p>}
          {v.lastTurn && v.reply && (
            <p className="timing" data-testid="turn-timing" title="Cuánto tardó la respuesta y cada parte que trabajó">
              Respondió en {seconds(v.lastTurn.ms)}{v.lastTurn.agents.map(a => ` · ${SECTION_LABEL[a.id].name} ${seconds(a.ms)}`).join('')}
            </p>
          )}
        </div>
      )}
      {v.error && <div className="orb-error" role="alert">{v.error}</div>}

      {pending.length > 0 && (
        <aside className="orb-cards" aria-label="Acciones pendientes">
          {pending.map(c => <ActionCard key={c.id} card={c} onChange={n => { v.setCards(list => list.map(x => (x.id === n.id ? n : x))); onActivity(); }} />)}
        </aside>
      )}

      <div className="orb-corner bl">
        <button type="button" className="orb-ctl" aria-pressed={keyboard} onClick={() => setKeyboard(k => !k)}>Teclado</button>
        <button type="button" className="orb-ctl" aria-pressed={captions} onClick={() => setCaptions(c => !c)}>Subtítulos</button>
        <button type="button" className="orb-ctl" aria-pressed={v.voiceOn && v.voiceReady} disabled={!v.voiceReady} onClick={v.toggleVoice}
          title={v.voiceReady ? 'Leer las respuestas en voz alta (también las que pides por teclado)' : 'Falta configurar la voz de Nyvo'}>Voz</button>
      </div>
      {keyboard && (
        <form className="orb-type" onSubmit={e => { e.preventDefault(); v.sendText(text); setText(''); }}>
          <label htmlFor="orb-input" className="sr-only">Mensaje para Nyvo</label>
          <input id="orb-input" value={text} onChange={e => setText(e.target.value)} placeholder="Escribe a Nyvo…" maxLength={4000} autoFocus autoComplete="off" />
          <button type="submit" className="orb-ctl primary" disabled={busy || !text.trim()}>Enviar</button>
        </form>
      )}
    </main>
  );
}
