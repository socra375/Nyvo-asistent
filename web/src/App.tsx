import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setUnauthorizedHandler, type Job, type SessionInfo } from './lib/api';
import { Login } from './Login';
import { Core, type CoreState } from './hud/Core';
import { ClientsPanel, DrivePanel, JobsPanel, NotionPanel } from './panels/panels';
import { Chat } from './panels/Chat';
import { ConnectorsView } from './panels/Connectors';
import { MemoryView } from './panels/Memory';

type View = 'centro' | 'conectores' | 'memoria';

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  return <span className="clock">{now.toLocaleString('es', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>;
}

/** Lee ?error= y ?conectado= del retorno de Google y limpia la URL. */
function takeUrlMessage(): { text: string; err: boolean } | null {
  const p = new URLSearchParams(window.location.search);
  const error = p.get('error');
  const ok = p.get('conectado');
  if (!error && !ok) return null;
  window.history.replaceState(null, '', window.location.pathname);
  return error ? { text: error, err: true } : { text: `Conectado: ${ok}.`, err: false };
}

export function App() {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [view, setView] = useState<View>('centro');
  const [core, setCore] = useState<CoreState>('reposo');
  const [refreshKey, setRefreshKey] = useState(0);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [toast, setToast] = useState<{ text: string; err: boolean } | null>(() => takeUrlMessage());

  const notify = useCallback((text: string, err = false) => setToast({ text, err }), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);

  const loadSession = useCallback(async () => {
    try { setInfo(await api<SessionInfo>('/api/session')); setLoadErr(null); }
    catch (e) { setLoadErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void loadSession(); setUnauthorizedHandler(() => setInfo(i => (i ? { ...i, user: null } : i))); }, [loadSession]);

  const user = info?.user ?? null;
  const loadJobs = useCallback(async () => {
    try { setJobs((await api<{ jobs: Job[] }>('/api/jobs')).jobs); } catch { /* el panel queda como estaba */ }
  }, []);
  useEffect(() => { if (user) void loadJobs(); }, [user, loadJobs, refreshKey]);
  const active = jobs?.filter(j => j.status === 'queued' || j.status === 'running').length ?? 0;
  useEffect(() => {
    if (!user || !active) return;
    const t = setInterval(() => { void loadJobs(); }, 8000);
    return () => clearInterval(t);
  }, [user, active, loadJobs]);

  // Cuando termina un trabajo en segundo plano, se refrescan paneles y conversación (su resultado llega al chat).
  const prevActive = useRef(0);
  useEffect(() => {
    if (active < prevActive.current) setRefreshKey(k => k + 1);
    prevActive.current = active;
  }, [active]);

  const onActivity = useCallback(() => setRefreshKey(k => k + 1), []);
  const runNow = useCallback(async () => {
    const r = await api<{ processed: number; failed: number }>('/api/jobs/run', { method: 'POST' });
    notify(`Trabajos procesados: ${r.processed}${r.failed ? ` · fallidos: ${r.failed}` : ''}.`);
    onActivity();
  }, [notify, onActivity]);

  if (loadErr) {
    return <main className="login"><div className="panel"><div className="notice err" role="alert">{loadErr}</div><button type="button" className="btn" onClick={loadSession}>Reintentar</button></div></main>;
  }
  if (!info) return <main className="login"><div className="panel" aria-busy="true">Cargando…</div></main>;
  if (!user) return <Login info={info} onLogin={u => setInfo({ ...info, user: u })} error={toast?.err ? toast.text : null} />;

  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); setInfo({ ...info, user: null }); };
  const goConnectors = () => setView('conectores');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><strong>NYVO</strong><span>// AINOVA SYSTEM</span></div>
        <nav className="tabs" role="tablist" aria-label="Secciones">
          {(['centro', 'conectores', 'memoria'] as View[]).map(v => (
            <button key={v} type="button" role="tab" className="tab" aria-selected={view === v} onClick={() => setView(v)}>
              {v === 'centro' ? 'Centro de mando' : v === 'conectores' ? 'Conectores' : 'Memoria'}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <Clock />
        <span className="who" title={user.email}>{user.email}</span>
        <button type="button" className="btn small" onClick={logout}>Salir</button>
      </header>

      {view === 'centro' && (
        <main className="grid">
          <ClientsPanel refreshKey={refreshKey} goConnectors={goConnectors} />
          <div className="area-center">
            <section className="panel" aria-label="Estado de Nyvo"><Core state={core} jobsActive={active} /></section>
            <Chat setCore={setCore} onActivity={onActivity} notify={notify} refreshKey={refreshKey} />
          </div>
          <DrivePanel refreshKey={refreshKey} goConnectors={goConnectors} />
          <JobsPanel jobs={jobs} reload={loadJobs} onRunNow={runNow} />
          <NotionPanel refreshKey={refreshKey} goConnectors={goConnectors} />
        </main>
      )}
      {view === 'conectores' && <ConnectorsView notify={notify} />}
      {view === 'memoria' && <MemoryView notify={notify} />}

      {toast && (
        <div className={`toast ${toast.err ? 'err' : ''}`} role={toast.err ? 'alert' : 'status'}>
          <span>{toast.text}</span>
          <button type="button" className="btn small ghost" onClick={() => setToast(null)} aria-label="Cerrar aviso">✕</button>
        </div>
      )}
    </div>
  );
}
