import { useEffect, useState } from 'react';
import { api, type ConnectorStatus } from '../lib/api';
import { Panel, Skeleton } from '../hud/Panel';

const STATE: Record<ConnectorStatus['state'], string> = {
  listo: 'Listo', falta_configurar: 'Falta configurar', falta_conectar: 'Falta conectar', desactivado: 'Desactivado'
};
const ROLE: Record<string, string> = { negocios: 'Especialista Negocios', documentos: 'Especialista Documentos', nucleo: 'Núcleo', navegador: 'Navegador', habilidades: 'Habilidades' };

export function ConnectorsView({ notify, onChanged }: { notify: (m: string, err?: boolean) => void; onChanged?: () => void }) {
  const [list, setList] = useState<ConnectorStatus[] | null>(null);
  useEffect(() => { void api<{ connectors: ConnectorStatus[] }>('/api/connectors').then(r => setList(r.connectors)).catch(e => notify(String(e.message ?? e), true)); }, [notify]);

  const save = async (id: string, body: { enabled?: boolean; settings?: Record<string, unknown> }) => {
    try {
      setList((await api<{ connectors: ConnectorStatus[] }>(`/api/connectors/${id}`, { method: 'PUT', body })).connectors);
      notify('Ajuste guardado.');
      onChanged?.();   // las tarjetas abiertas (Clientes, Archivos, Notion) vuelven a leer su estado
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
  };

  return (
    <div className="page">
      <h1>Conectores</h1>
      <p className="intro">Cada integración usa variables que viven solo en el servidor (Vercel). Si falta alguna, el conector aparece como «falta configurar» y Nyvo no lo usa. Ninguna clave llega al navegador.</p>
      {!list ? <Skeleton rows={6} /> : (
        <div className="cards-grid">
          {list.map(c => (
            <Panel key={c.id} id={`conector-${c.id}`} title={c.title} tag={ROLE[c.role] ?? c.role}>
              <div className="conn">
                <span className={`badge ${c.state}`}>{STATE[c.state]}</span>
                <p>{c.description}</p>
                <div className="label">Variables</div>
                <div className="vars">{c.requiredEnv.map(v => <code key={v} title={c.missingEnv.includes(v) ? 'Falta' : 'Configurada'}>{c.missingEnv.includes(v) ? '✗ ' : '✓ '}{v}</code>)}</div>
                {c.state === 'falta_conectar' && (
                  <p><a className="btn primary small" href={`/api/auth/google/start?purpose=connector&connector=${c.id}`}>Conectar con Google</a></p>
                )}
                {c.id === 'notion' && (
                  <p>
                    <label className="switch">
                      <input type="checkbox" checked={c.settings.autoGuardar !== false} onChange={e => save(c.id, { settings: { autoGuardar: e.target.checked } })} />
                      Guardar notas y reportes sin preguntar (con opción de deshacer)
                    </label>
                  </p>
                )}
                {c.state !== 'falta_configurar' && c.role !== 'nucleo' && (
                  <label className="switch">
                    <input type="checkbox" checked={c.state !== 'desactivado'} onChange={e => save(c.id, { enabled: e.target.checked })} />
                    Activo
                  </label>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
