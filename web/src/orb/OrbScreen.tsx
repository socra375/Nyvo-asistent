import { useState } from 'react';
import { Orb } from './Orb';
import { useOrbVoice } from '../voice/useOrbVoice';
import { ActionCard } from '../panels/Chat';

interface Props {
  onActivity: () => void;
  notify: (m: string, err?: boolean) => void;
  openPanel: () => void;
  logout: () => void;
  jobsActive: number;
}

const HINT = {
  reposo: 'Toca el orbe para hablar con Nyvo',
  escuchando: 'Te escucho… habla cuando quieras',
  pensando: 'Pensando…',
  hablando: 'Hablando… háblame para interrumpir'
} as const;

/** Pantalla principal: solo el orbe. Todo lo demás (panel, teclado, subtítulos) son controles discretos en las esquinas. */
export function OrbScreen({ onActivity, notify, openPanel, logout, jobsActive }: Props) {
  const v = useOrbVoice(onActivity, notify);
  const [keyboard, setKeyboard] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [text, setText] = useState('');
  const pending = v.cards.filter(c => c.status === 'pending' || (c.kind === 'undo' && c.status === 'done'));
  const busy = v.state === 'pensando';

  return (
    <main className="orbscreen" data-testid="orbscreen">
      <div className="orb-corner tl">
        <img className="orb-logo" src="/logo-96.png" alt="" width={28} height={28} />
        <strong>NYVO</strong>
      </div>
      <div className="orb-corner tr">
        <button type="button" className="orb-ctl" onClick={openPanel}>Panel</button>
        <button type="button" className="orb-ctl" onClick={logout}>Salir</button>
      </div>

      <button type="button" className="orb-hit" onClick={v.toggle} disabled={!v.sttReady && !v.live}
        aria-pressed={v.live} aria-label={v.live ? 'Detener la conversación por voz' : 'Hablar con Nyvo'}
        title={v.sttReady ? '' : 'Falta configurar Gemini para usar la voz. Puedes escribirle con el teclado.'}>
        <Orb state={v.state} sections={v.sections} getLevel={v.getLevel} />
      </button>

      <div className="orb-status" aria-live="polite" data-testid="orb-status">
        {v.sttReady || v.live ? HINT[v.state] : 'Voz sin configurar: escríbele a Nyvo con el teclado'}
        {jobsActive ? ` · ${jobsActive} trabajo${jobsActive > 1 ? 's' : ''} en curso` : ''}
      </div>
      {v.state === 'hablando' && <button type="button" className="orb-ctl stop" onClick={v.stopSpeaking}>Callar</button>}

      {captions && (v.heard || v.reply) && (
        <div className="orb-captions" data-testid="captions">
          {v.heard && <p className="heard"><span>Tú</span>{v.heard}</p>}
          {v.reply && <p className="said"><span>Nyvo</span>{v.reply}</p>}
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
