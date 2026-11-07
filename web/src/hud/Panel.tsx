import type { ReactNode } from 'react';
import type { PanelResponse } from '../lib/api';

export function Panel({ title, tag, actions, className = '', children, id }: { title: string; tag?: string; actions?: ReactNode; className?: string; children: ReactNode; id?: string }) {
  return (
    <section className={`panel ${className}`} aria-labelledby={id ? `${id}-h` : undefined} data-testid={id}>
      <div className="panel-head">
        <h2 id={id ? `${id}-h` : undefined}>{title}</h2>
        {tag && <span className="tag">{tag}</span>}
        {actions && <div className="actions">{actions}</div>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div aria-busy="true" aria-label="Cargando">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" />)}</div>;
}

/** Estado de un panel que depende de un conector: «falta configurar», «falta conectar», desactivado o error. */
export function ConnectorNotice({ res, connectorId, onGoToConnectors }: { res: PanelResponse<unknown>; connectorId: string; onGoToConnectors: () => void }) {
  if (res.state === 'falta_configurar') {
    return (
      <div className="notice warn" role="status">
        <p><span className="badge falta_configurar">Falta configurar</span></p>
        <p>Faltan estas variables en el servidor:</p>
        <div className="row">{res.missingEnv?.map(v => <code key={v}>{v}</code>)}</div>
        <p><button type="button" className="btn small ghost" onClick={onGoToConnectors}>Ver conectores →</button></p>
      </div>
    );
  }
  if (res.state === 'falta_conectar') {
    return (
      <div className="notice" role="status">
        <p><span className="badge falta_conectar">Falta conectar</span></p>
        <p>Autoriza a Nyvo a ver los metadatos de tus archivos (solo lectura).</p>
        <a className="btn primary small" href={`/api/auth/google/start?purpose=connector&connector=${connectorId}`}>Conectar con Google</a>
      </div>
    );
  }
  if (res.state === 'desactivado') return <div className="notice" role="status">Conector desactivado. Actívalo en Conectores.</div>;
  return <div className="notice err" role="alert">No se pudo cargar: {res.error ?? 'error desconocido'}</div>;
}
