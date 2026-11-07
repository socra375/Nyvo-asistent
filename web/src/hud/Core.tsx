export type CoreState = 'reposo' | 'escuchando' | 'pensando' | 'hablando';

const CLASS: Record<CoreState, string> = { reposo: '', escuchando: 'listening', pensando: 'thinking', hablando: 'speaking' };
const LABEL: Record<CoreState, string> = { reposo: 'En línea', escuchando: 'Escuchando…', pensando: 'Pensando…', hablando: 'Hablando…' };

/** Núcleo de Nyvo: reacciona a la voz y al estado del agente. */
export function Core({ state, jobsActive }: { state: CoreState; jobsActive: number }) {
  return (
    <div className="core-wrap" data-testid="core" data-state={state}>
      <svg className={`core ${CLASS[state]}`} viewBox="0 0 200 200" role="img" aria-label={`Núcleo de Nyvo: ${LABEL[state]}`}>
        <defs>
          <radialGradient id="orbGrad" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor="#c9fff4" />
            <stop offset="35%" stopColor="#3ef0d0" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#0a3d44" stopOpacity="0.2" />
          </radialGradient>
        </defs>
        <circle className="ring r3" cx="100" cy="100" r="94" />
        <circle className="ring r1" cx="100" cy="100" r="82" />
        <circle className="ring r2" cx="100" cy="100" r="66" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map(a => (
          <line key={a} className="tick" x1="100" y1="4" x2="100" y2="14" transform={`rotate(${a} 100 100)`} />
        ))}
        <circle className="orb" cx="100" cy="100" r="40" />
      </svg>
      <div className="core-info">
        <h1>NYVO</h1>
        <p>Segundo director · AINova System</p>
        <div className="core-state" aria-live="polite">{LABEL[state]}{jobsActive ? ` · ${jobsActive} trabajo${jobsActive > 1 ? 's' : ''} en curso` : ''}</div>
        <div className={`wave ${state === 'hablando' || state === 'escuchando' ? 'on' : ''}`} aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => <i key={i} />)}
        </div>
      </div>
    </div>
  );
}
