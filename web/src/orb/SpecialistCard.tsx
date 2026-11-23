import { SECTION_LABEL, SECTION_RGB, type Hemi, type SectionMode } from './orbModel';
import { SPECIALISTS, specialistStatus, type ConnectorMap } from './specialists';

/** Tarjeta contextual de un especialista. Solo informa: abrirla no ejecuta ninguna acción externa. */
export function SpecialistCard({ id, mode, conns, onClose }: { id: Hemi; mode: SectionMode; conns: ConnectorMap | null; onClose: () => void }) {
  const info = SPECIALISTS[id];
  const { name, role } = SECTION_LABEL[id];
  const [r, g, b] = SECTION_RGB[id];
  const status = specialistStatus(id, mode, conns);
  return (
    <section className="orb-spec" data-testid={`spec-${id}`} aria-label={`Tarjeta de ${name}`} style={{ '--tint': `${r}, ${g}, ${b}` } as React.CSSProperties}>
      <button type="button" className="orb-win-close" onClick={onClose} aria-label={`Cerrar ${name}`} title="Cerrar">✕</button>
      <h2>{name}</h2>
      <p className="spec-role">{role}</p>
      <p className="spec-status" data-testid={`spec-${id}-estado`} data-status={status}><i aria-hidden="true" />{status}</p>
      <p>{info.description}</p>
      {info.capabilities.length > 0 && (
        <>
          <div className="label">Capacidades</div>
          <ul>
            {info.capabilities.map(c => (
              <li key={c.text}>{c.text}{c.connector && conns?.[c.connector] === 'falta_configurar' ? <em> · falta configurar</em> : null}</li>
            ))}
          </ul>
        </>
      )}
      {info.note && <p className="spec-note">{info.note}</p>}
    </section>
  );
}
