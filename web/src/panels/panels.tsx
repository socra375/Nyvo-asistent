import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, money, type ClientsData, type Job, type PanelItem, type PanelResponse } from '../lib/api';
import { ConnectorNotice, Panel, Skeleton } from '../hud/Panel';

function usePanel<T>(url: string, refreshKey: number) {
  const [res, setRes] = useState<PanelResponse<T> | null>(null);
  const load = useCallback(async () => {
    try { setRes(await api<PanelResponse<T>>(url)); }
    catch (e) { setRes({ state: 'error', error: e instanceof Error ? e.message : String(e) }); }
  }, [url]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  return { res, reload: load };
}

const Reload = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" className="btn small ghost" onClick={onClick} aria-label={`Actualizar ${label}`} title="Actualizar">↻</button>
);

export function ClientsPanel({ refreshKey, goConnectors }: { refreshKey: number; goConnectors: () => void }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { res, reload } = usePanel<ClientsData>(`/api/panels/clients${query ? `?q=${encodeURIComponent(query)}` : ''}`, refreshKey);
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  const s = res?.data?.summary;
  return (
    <Panel id="panel-clientes" title="Clientes" tag="AINOVA" className="area-clients" actions={<Reload onClick={reload} label="clientes" />}>
      {!res ? <Skeleton rows={4} /> : res.state !== 'listo' ? <ConnectorNotice res={res} connectorId="ainova" onGoToConnectors={goConnectors} /> : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="label">Activos</div><div className="v accent">{s?.activeClients ?? '—'}</div></div>
            <div className="kpi"><div className="label">Proyectos</div><div className="v">{s?.activeProjects ?? '—'}</div></div>
            <div className="kpi"><div className="label">Por cobrar</div><div className="v warn">{money(s?.pending)}</div></div>
            <div className="kpi"><div className="label">Cobrado</div><div className="v">{money(s?.collected)}</div></div>
          </div>
          <label className="sr-only" htmlFor="buscar-cliente">Buscar cliente</label>
          <input id="buscar-cliente" className="search" placeholder="Buscar cliente…" value={q} onChange={e => setQ(e.target.value)} />
          {res.data!.clients.length === 0 ? <div className="empty">Sin clientes{query ? ' para esa búsqueda' : ''}.</div> : (
            <ul className="list">
              {res.data!.clients.slice(0, 12).map(c => (
                <li key={c.id}>
                  <div className="main"><span className="t">{c.name}</span><span className="s">{[c.company, c.email].filter(Boolean).join(' · ')}</span></div>
                  {c.status && <span className={`badge ${c.status}`}>{c.status}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

function ItemsPanel({ id, title, tag, url, connectorId, refreshKey, goConnectors, area, emptyText }: { id: string; title: string; tag: string; url: string; connectorId: string; refreshKey: number; goConnectors: () => void; area: string; emptyText: string }) {
  const { res, reload } = usePanel<PanelItem[]>(url, refreshKey);
  return (
    <Panel id={id} title={title} tag={tag} className={area} actions={<Reload onClick={reload} label={title} />}>
      {!res ? <Skeleton rows={4} /> : res.state !== 'listo' ? <ConnectorNotice res={res} connectorId={connectorId} onGoToConnectors={goConnectors} /> : res.data!.length === 0 ? <div className="empty">{emptyText}</div> : (
        <ul className="list">
          {res.data!.map(it => (
            <li key={it.id}>
              <div className="main">
                {it.url ? <a className="t" href={it.url} target="_blank" rel="noopener noreferrer">{it.title}</a> : <span className="t">{it.title}</span>}
                {it.subtitle && <span className="s">{it.subtitle}</span>}
              </div>
              {it.badge && <span className="badge listo">{it.badge}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export const DrivePanel = (p: { refreshKey: number; goConnectors: () => void }) => (
  <ItemsPanel id="panel-drive" title="Archivos principales" tag="GOOGLE DRIVE" url="/api/panels/drive" connectorId="google-drive" area="area-drive" emptyText="No hay archivos destacados ni recientes." {...p} />
);
export const NotionPanel = (p: { refreshKey: number; goConnectors: () => void }) => (
  <ItemsPanel id="panel-notion" title="Notion" tag="ARCHIVO DE NYVO" url="/api/panels/notion" connectorId="notion" area="area-notion" emptyText="Aún no hay notas ni reportes. Pídele a Nyvo que anote algo." {...p} />
);

const JOB_LABEL: Record<Job['status'], string> = { queued: 'en cola', running: 'en curso', done: 'hecho', failed: 'falló', cancelled: 'cancelado' };

export function JobsPanel({ jobs, reload, onRunNow }: { jobs: Job[] | null; reload: () => void; onRunNow: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const act = async (path: string) => { setBusy(true); try { await api(path, { method: 'POST' }); } finally { setBusy(false); reload(); } };
  const pending = jobs?.some(j => j.status === 'queued' || j.status === 'running');
  return (
    <Panel id="panel-trabajos" title="Trabajos" tag="SEGUNDO PLANO" className="area-jobs" actions={<>
      <button type="button" className="btn small" disabled={busy || !pending} onClick={async () => { setBusy(true); try { await onRunNow(); } finally { setBusy(false); } }}>Procesar ahora</button>
      <Reload onClick={reload} label="trabajos" />
    </>}>
      {!jobs ? <Skeleton rows={3} /> : jobs.length === 0 ? <div className="empty">No hay trabajos. Las tareas largas aparecen aquí y no se pierden si la petición se corta.</div> : (
        <ul className="list">
          {jobs.slice(0, 10).map(j => (
            <li key={j.id}>
              <div className="main">
                <span className="t">{j.title || j.kind}</span>
                <span className="s">{fmtDate(j.created_at)} · intento {j.attempts}/{j.max_attempts}{j.error ? ` · ${j.error}` : ''}</span>
              </div>
              <span className={`badge ${j.status}`}>{JOB_LABEL[j.status]}</span>
              {j.status === 'failed' && <button type="button" className="btn small" disabled={busy} onClick={() => act(`/api/jobs/${j.id}/retry`)}>Reintentar</button>}
              {j.status === 'queued' && <button type="button" className="btn small ghost" disabled={busy} onClick={() => act(`/api/jobs/${j.id}/cancel`)}>Cancelar</button>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
