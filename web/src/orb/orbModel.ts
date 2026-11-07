/**
 * Modelo del orbe de Nyvo (puro, sin DOM): partículas sobre una esfera, las cuatro secciones fijas en pantalla
 * (Rose, Johan, Mia, Nyvo) y la dinámica suavizada de cada estado. El dibujo (orbRender.ts) solo lee este modelo.
 */
export type Hemi = 'rose' | 'johan' | 'mia' | 'nyvo';
export type Mode = 'reposo' | 'escuchando' | 'pensando' | 'hablando';
export type SectionMode = 'reposo' | 'activo' | 'listo';

/** Orden en pantalla: arriba-izquierda, arriba-derecha, abajo-derecha, abajo-izquierda. */
export const SECTIONS: readonly Hemi[] = ['rose', 'johan', 'mia', 'nyvo'];
/** Centro angular de cada sección (radianes, y hacia abajo): -135°, -45°, 45°, 135°. */
export const SECTION_CENTER: Record<Hemi, number> = { rose: -0.75 * Math.PI, johan: -0.25 * Math.PI, mia: 0.25 * Math.PI, nyvo: 0.75 * Math.PI };

/** Paleta dorada de la referencia; cada sección lleva un matiz propio, sin salirse de la familia cálida. */
export const SECTION_RGB: Record<Hemi, [number, number, number]> = {
  rose: [255, 160, 128],    // oro rosado
  johan: [255, 196, 64],    // oro ámbar
  mia: [150, 226, 200],     // champán verdoso
  nyvo: [255, 236, 170]     // oro claro
};
export const SECTION_LABEL: Record<Hemi, { name: string; role: string }> = {
  rose: { name: 'Rose', role: 'Mensajes' },
  johan: { name: 'Johan', role: 'Clientes y cobros' },
  mia: { name: 'Mia', role: 'Agenda' },
  nyvo: { name: 'Nyvo', role: 'Estrategia y archivo' }
};

export interface Particle { x: number; y: number; z: number; seed: number; size: number }

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Puntos repartidos de forma uniforme por la esfera (espiral de Fibonacci). Determinista: misma semilla, mismo orbe. */
export function createParticles(n: number, seed = 7): Particle[] {
  const rnd = mulberry32(seed);
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    return { x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: rnd() * Math.PI * 2, size: 0.55 + rnd() * rnd() * 1.9 };
  });
}

const angDist = (a: number, b: number) => { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };

/** Peso de cada sección en un ángulo de pantalla: 1 en su centro y baja en línea recta hasta 0 en la sección vecina; la suma es 1. */
export function sectionWeights(angle: number): Record<Hemi, number> {
  const w = {} as Record<Hemi, number>;
  for (const s of SECTIONS) w[s] = Math.max(0, 1 - angDist(angle, SECTION_CENTER[s]) / (Math.PI / 2));
  return w;
}

/** Sección dominante en un ángulo de pantalla (las cuatro mitades son fijas aunque el orbe gire). */
export function sectionAt(angle: number): Hemi {
  let best: Hemi = 'rose', bw = -1;
  const w = sectionWeights(angle);
  for (const s of SECTIONS) if (w[s] > bw) { bw = w[s]; best = s; }
  return best;
}

export interface Targets { spin: number; ring: number; glow: number; pulseHz: number; swirl: number; reach: number }
/** Hacia dónde tiende la animación en cada estado. */
export const TARGETS: Record<Mode, Targets> = {
  reposo:     { spin: 0.20, ring: 0.10, glow: 0.50, pulseHz: 0.25, swirl: 0.30, reach: 0.00 },
  escuchando: { spin: 0.32, ring: 0.22, glow: 0.70, pulseHz: 0.50, swirl: 0.45, reach: 0.18 },
  pensando:   { spin: 0.95, ring: 0.80, glow: 0.85, pulseHz: 1.60, swirl: 0.90, reach: 0.06 },
  hablando:   { spin: 0.42, ring: 0.28, glow: 0.95, pulseHz: 0.80, swirl: 0.55, reach: 0.30 }
};

export interface Dynamics {
  mode: Mode;
  yaw: number; ringPhase: number; clock: number;
  spin: number; ring: number; glow: number; pulseHz: number; swirl: number; reach: number;
  /** Nivel de audio suavizado 0..1. */
  level: number;
  /** Activación suavizada de cada sección 0..1. */
  act: Record<Hemi, number>;
  /** Sección que «recorre» el orbe mientras piensa sin herramienta activa. */
  sweep: number;
}

export const createDynamics = (): Dynamics => ({
  mode: 'reposo', yaw: 0, ringPhase: 0, clock: 0, ...TARGETS.reposo, level: 0, act: { rose: 0, johan: 0, mia: 0, nyvo: 0 }, sweep: 0
});

/** Acerca x a su objetivo con constante de tiempo tau (independiente de los fps). */
export const approach = (x: number, target: number, dt: number, tau: number) => x + (target - x) * (1 - Math.exp(-dt / tau));

export interface StepInput { mode: Mode; sections: Record<Hemi, SectionMode>; level: number; reducedMotion?: boolean }

/** Avanza la dinámica dt segundos. Con «reducir movimiento» el giro y los pulsos se atenúan mucho. */
export function stepDynamics(d: Dynamics, dt: number, inp: StepInput): void {
  dt = Math.min(dt, 0.1);   // si la pestaña estuvo en segundo plano, no dar un salto
  const t = TARGETS[inp.mode];
  const calm = inp.reducedMotion ? 0.25 : 1;
  d.mode = inp.mode;
  d.spin = approach(d.spin, t.spin * calm, dt, 0.6);
  d.ring = approach(d.ring, t.ring * calm, dt, 0.8);
  d.glow = approach(d.glow, t.glow, dt, 0.5);
  d.pulseHz = approach(d.pulseHz, t.pulseHz * calm, dt, 0.5);
  d.swirl = approach(d.swirl, t.swirl * calm, dt, 0.7);
  d.reach = approach(d.reach, t.reach, dt, 0.4);
  d.level = approach(d.level, inp.level, dt, inp.level > d.level ? 0.05 : 0.18);   // sube rápido, baja despacio
  d.yaw += d.spin * dt;
  d.ringPhase += d.ring * dt;
  d.clock += dt;

  const anyActive = SECTIONS.some(s => inp.sections[s] === 'activo');
  d.sweep = (d.sweep + dt / 1.2) % SECTIONS.length;
  for (const s of SECTIONS) {
    let target = inp.sections[s] === 'activo' ? 1 : inp.sections[s] === 'listo' ? 0.6 : 0.18;
    // Pensando sin herramienta: el brillo recorre las cuatro secciones en orden.
    if (inp.mode === 'pensando' && !anyActive && !inp.reducedMotion) {
      const idx = SECTIONS.indexOf(s);
      const dist = Math.min(Math.abs(d.sweep - idx), SECTIONS.length - Math.abs(d.sweep - idx));
      target = Math.max(target, 0.9 - dist * 0.45);
    }
    d.act[s] = approach(d.act[s], target, dt, target > d.act[s] ? 0.18 : 0.45);
  }
}

export interface Projected { sx: number; sy: number; depth: number; angle: number }

/** Proyecta una partícula: giro diferencial por latitud, inclinación fija y perspectiva suave. Devuelve coordenadas relativas al centro (radio 1). */
export function project(p: Particle, d: Dynamics, out: Projected): Projected {
  const tilt = 0.38;
  // Giro más rápido en el ecuador que en los polos: la esfera «fluye» en vez de girar como un bloque.
  const yaw = d.yaw * (1 + d.swirl * 0.5 * (1 - Math.abs(p.y)));
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const y2 = p.y * ct - z1 * st;
  const z2 = p.y * st + z1 * ct;
  // Respiración + empuje hacia fuera con la voz.
  const breathe = 1 + 0.025 * Math.sin(d.clock * Math.PI * 2 * d.pulseHz + p.seed) + d.level * d.reach * (0.6 + 0.4 * Math.sin(p.seed * 3 + d.clock * 7));
  const persp = 1 / (1 - z2 * 0.22);
  out.sx = x1 * breathe * persp;
  out.sy = y2 * breathe * persp;
  out.depth = z2;
  out.angle = Math.atan2(out.sy, out.sx);
  return out;
}
