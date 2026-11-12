import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setUnauthorizedHandler, type Job, type SessionInfo } from './lib/api';
import { Login } from './Login';
import { OrbScreen } from './orb/OrbScreen';

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
  // Si llegamos de vuelta de Google (?conectado= / ?error=), se abre la tarjeta de Conectores para ver el resultado.
  const [urlMsg] = useState(() => takeUrlMessage());
  const [refreshKey, setRefreshKey] = useState(0);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [toast, setToast] = useState<{ text: string; err: boolean } | null>(urlMsg);

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

  // Una sola pantalla: el orbe, con las tarjetas encima. Ya no hay un panel aparte.
  return (
    <>
      <OrbScreen onActivity={onActivity} notify={notify} logout={logout} refreshKey={refreshKey} jobs={jobs} jobsActive={active} loadJobs={loadJobs} runNow={runNow}
        initialOpen={urlMsg ? 'conectores' : undefined} />
      {toast && (
        <div className={`toast ${toast.err ? 'err' : ''}`} role={toast.err ? 'alert' : 'status'}>
          <span>{toast.text}</span>
          <button type="button" className="btn small ghost" onClick={() => setToast(null)} aria-label="Cerrar aviso">✕</button>
        </div>
      )}
    </>
  );
}
