import { useEffect, useMemo, useRef } from 'react';
import { createDynamics, createGraph, SECTIONS, SECTION_LABEL, SECTION_RGB, stepDynamics, type Hemi, type Mode, type SectionMode } from './orbModel';
import { drawOrb } from './orbRender';

interface Props {
  state: Mode;
  sections: Record<Hemi, SectionMode>;
  /** Nivel de audio 0..1 (lectura barata, se consulta en cada fotograma). */
  getLevel: () => number;
}

const STATE_TEXT: Record<Mode, string> = { reposo: 'En reposo', escuchando: 'Escuchando', pensando: 'Pensando', hablando: 'Hablando' };

/** El orbe de Nyvo: grafo de red en 3D que gira; sus cuatro clústeres son Rose, Johan, Mia y Nyvo. */
export function Orb({ state, sections, getLevel }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, sections, getLevel });
  useEffect(() => { live.current = { state, sections, getLevel }; }, [state, sections, getLevel]);
  const dyn = useRef(createDynamics());

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let w = 0, h = 0, dpr = 1, graph = createGraph(900);
    const fit = () => {
      const r = el.getBoundingClientRect();
      w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Pantallas pequeñas: menos nodos para mantener la fluidez.
      const n = Math.min(w, h) < 420 ? 520 : 900;
      if ((n === 520) !== (graph.nodes.length < 700)) graph = createGraph(n);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    let raf = 0, last = performance.now(), frames = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const cur = live.current;
      stepDynamics(dyn.current, dt, { mode: cur.state, sections: cur.sections, level: cur.getLevel(), reducedMotion: reduce.matches }, graph);
      drawOrb(ctx, w, h, dyn.current, graph);
      if (++frames % 6 === 0) { el.dataset.yaw = dyn.current.yaw.toFixed(3); el.dataset.frames = String(frames); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  const active = useMemo(() => SECTIONS.filter(s => sections[s] === 'activo'), [sections]);
  return (
    <div className="orb-stage" data-testid="orb" data-state={state} data-active={active.join(' ')} role="img"
      aria-label={`Orbe de Nyvo: ${STATE_TEXT[state]}${active.length ? `. Trabajando: ${active.map(s => SECTION_LABEL[s].name).join(', ')}` : ''}`}>
      <canvas ref={canvas} className="orb-canvas" data-testid="orb-canvas" />
    </div>
  );
}

const MODE_TEXT: Record<SectionMode, string> = { reposo: 'Disponible', activo: 'Trabajando', listo: 'Listo' };

/** Los cuatro nombres del orbe como botones (fuera del botón de voz): abren la tarjeta del especialista, sin ejecutar nada. */
export function OrbLabels({ sections, selected, onSelect }: { sections: Record<Hemi, SectionMode>; selected: Hemi | null; onSelect: (s: Hemi) => void }) {
  return (
    <div className="orb-labels">
      {SECTIONS.map(s => {
        const [r, g, b] = SECTION_RGB[s];
        return (
          <button key={s} type="button" className={`orb-label ${s}`} data-testid={`sec-${s}`} data-mode={sections[s]}
            aria-pressed={selected === s} aria-label={`${SECTION_LABEL[s].name}: ${SECTION_LABEL[s].role}. ${MODE_TEXT[sections[s]]}. Ver tarjeta`}
            onClick={() => onSelect(s)} style={{ '--tint': `${r}, ${g}, ${b}` } as React.CSSProperties}>
            <b>{SECTION_LABEL[s].name}</b><span>{SECTION_LABEL[s].role}</span>
          </button>
        );
      })}
    </div>
  );
}
