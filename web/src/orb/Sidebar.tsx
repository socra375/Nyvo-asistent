import type { ReactNode } from 'react';
import type { WinId } from './OrbScreen';

const ico = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{d}</svg>
);
export const ICONS: Record<string, ReactNode> = {
  principal: ico(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" /></>),
  actividad: ico(<path d="M3 12h4l3-7 4 14 3-7h4" />),
  clientes: ico(<><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><path d="M16 5.5a3 3 0 0 1 0 5.5M18 14.8c1.8.7 3 2.4 3 5.2" /></>),
  trabajos: ico(<><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18" /></>),
  conversacion: ico(<path d="M4 5h16v11H9l-5 4z" />),
  archivos: ico(<path d="M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />),
  notion: ico(<><path d="M6 3h9l4 4v14H6z" /><path d="M9 11h7M9 15h7" /></>),
  memoria: ico(<><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 5 1V4a3 3 0 0 0-2 0zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-5 1" /></>),
  conectores: ico(<><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" /></>),
  voces: ico(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  menu: ico(<path d="M4 7h16M4 12h16M4 17h16" />),
  colapsar: ico(<path d="M15 5l-7 7 7 7" />),
  expandir: ico(<path d="M9 5l7 7-7 7" />)
};

interface Item { key: string; label: string; win?: WinId }
const GROUPS: { id: string; title: string; items: Item[] }[] = [
  { id: 'centro', title: 'Centro', items: [{ key: 'principal', label: 'Vista principal' }, { key: 'actividad', label: 'Actividad', win: 'actividad' }] },
  { id: 'negocios', title: 'Negocios', items: [{ key: 'clientes', label: 'Clientes', win: 'clientes' }, { key: 'trabajos', label: 'Trabajos', win: 'trabajos' }, { key: 'conversacion', label: 'Conversación', win: 'conversacion' }] },
  { id: 'conocimiento', title: 'Conocimiento', items: [{ key: 'archivos', label: 'Archivos', win: 'archivos' }, { key: 'notion', label: 'Notion', win: 'notion' }, { key: 'memoria', label: 'Memoria', win: 'memoria' }] },
  { id: 'sistemas', title: 'Sistemas', items: [{ key: 'conectores', label: 'Conectores', win: 'conectores' }, { key: 'voces', label: 'Voces', win: 'voces' }] }
];

interface Props {
  open: WinId[];
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  toggle: (id: WinId) => void;
  goHome: () => void;
  jobsActive: number;
}

/** Barra lateral con cuatro grupos. En móvil (≤640 px) es un menú desplegable. */
export function Sidebar({ open, collapsed, setCollapsed, menuOpen, setMenuOpen, toggle, goHome, jobsActive }: Props) {
  const home = open.length === 0;
  return (
    <aside className="orb-side" data-collapsed={collapsed} data-menu={menuOpen} data-testid="sidebar">
      <button type="button" className="orb-side-menu" aria-expanded={menuOpen} aria-controls="orb-nav" onClick={() => setMenuOpen(!menuOpen)}>
        {ICONS.menu}<span>Menú</span>
      </button>
      <nav id="orb-nav" className="orb-nav" aria-label="Tarjetas">
        {GROUPS.map(g => (
          <div key={g.id} role="group" aria-labelledby={`grp-${g.id}`} className="orb-grp" data-testid={`grupo-${g.id}`}>
            <h2 id={`grp-${g.id}`} className="orb-grp-t">{g.title}</h2>
            {g.items.map(it => {
              const pressed = it.win ? open.includes(it.win) : undefined;
              return (
                <button key={it.key} type="button" className="orb-nav-btn" title={it.label}
                  aria-pressed={pressed} aria-current={!it.win && home ? 'page' : undefined}
                  onClick={() => (it.win ? toggle(it.win) : goHome())}>
                  {ICONS[it.key]}
                  <span className="orb-nav-l">{it.label}</span>
                  {it.win === 'trabajos' && jobsActive ? <span className="orb-badge" aria-label={`${jobsActive} en curso`}>{jobsActive}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
        <button type="button" className="orb-nav-btn orb-collapse" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expandir barra lateral' : 'Contraer barra lateral'} title={collapsed ? 'Expandir' : 'Contraer'}>
          {collapsed ? ICONS.expandir : ICONS.colapsar}<span className="orb-nav-l">Contraer</span>
        </button>
      </nav>
    </aside>
  );
}
