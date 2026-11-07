/**
 * Modelo del orbe de Nyvo (puro, sin DOM): un grafo de red en 3D. Cada hemisferio del cerebro (Rose, Johan, Mia,
 * Nyvo) es un clúster de nodos con su color; los «hubs» llevan el nombre de lo que conectan. El dibujo
 * (orbRender.ts) solo lee este modelo; todo lo que tiene fórmula se prueba sin navegador.
 */
export type Hemi = 'rose' | 'johan' | 'mia' | 'nyvo';
export type Mode = 'reposo' | 'escuchando' | 'pensando' | 'hablando';
export type SectionMode = 'reposo' | 'activo' | 'listo';

export const SECTIONS: readonly Hemi[] = ['rose', 'johan', 'mia', 'nyvo'];
export type RGB = [number, number, number];

/** Rose rosa (centro), Johan naranja (casquete izquierdo), Mia azul (derecha), Nyvo amarillo (hubs). */
export const SECTION_RGB: Record<Hemi, RGB> = {
  rose: [226, 92, 150],
  johan: [222, 148, 84],
  mia: [92, 164, 214],
  nyvo: [244, 208, 64]
};
export const SECTION_LABEL: Record<Hemi, { name: string; role: string }> = {
  rose: { name: 'Rose', role: 'Mensajes' },
  johan: { name: 'Johan', role: 'Clientes y cobros' },
  mia: { name: 'Mia', role: 'Agenda' },
  nyvo: { name: 'Nyvo', role: 'Estrategia y archivo' }
};

/** Nodos grandes con nombre: lo que cada hemisferio conecta de verdad (no son datos del negocio, solo su estructura). */
export const HUBS: readonly { sec: Hemi; label: string }[] = [
  { sec: 'rose', label: 'Mensajes' }, { sec: 'rose', label: 'Conversaciones' },
  { sec: 'johan', label: 'Clientes' }, { sec: 'johan', label: 'Cobros' }, { sec: 'johan', label: 'Proyectos' }, { sec: 'johan', label: 'Facturas' },
  { sec: 'mia', label: 'Agenda' }, { sec: 'mia', label: 'Formularios' },
  { sec: 'nyvo', label: 'Notion' }, { sec: 'nyvo', label: 'Drive' }, { sec: 'nyvo', label: 'Memoria' }, { sec: 'nyvo', label: 'Estrategia' }, { sec: 'nyvo', label: 'Reportes' }
];
const NYVO_HUB_RGB: RGB[] = [[244, 208, 64], [62, 224, 208], [182, 156, 255]];

export interface GNode { x: number; y: number; z: number; sec: Hemi; size: number; seed: number; rgb: RGB; label?: string }
export interface Graph {
  nodes: GNode[];
  edges: [number, number][];
  /** Sección a la que pertenece cada arista (la del nodo de origen). */
  edgeSec: Hemi[];
  edgesBySec: Record<Hemi, number[]>;
  hubs: number[];
}

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Elipsoide de la escena: más ancho que alto, como la referencia. */
const RX = 1.0, RY = 0.84, RZ = 0.84;
const dist2 = (a: GNode, b: GNode) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

/** Grafo determinista (misma semilla, mismo orbe) con `n` nodos aproximadamente. */
export function createGraph(n: number, seed = 11): Graph {
  const rnd = mulberry32(seed);
  const nodes: GNode[] = [];
  const push = (x: number, y: number, z: number, sec: Hemi, size: number, rgb?: RGB, label?: string) =>
    nodes.push({ x: x * RX, y: y * RY, z: z * RZ, sec, size, seed: rnd() * Math.PI * 2, rgb: rgb ?? SECTION_RGB[sec], label });

  const nMia = Math.round(n * 0.26), nRose = Math.round(n * 0.2);

  // Johan: casquete en el lado izquierdo, en filas curvas de puntos (anillos de latitud) como el borde naranja de la referencia.
  const bands = 26, perRing = n * 0.04;
  for (let k = 0; k < bands; k++) {
    const theta = 0.04 + (k / (bands - 1)) * 1.1;                        // ángulo respecto al eje -x
    const m = Math.max(5, Math.round(Math.sin(theta) * perRing));
    for (let j = 0; j < m; j++) {
      const alpha = ((j + rnd() * 0.35) / m) * Math.PI * 2;
      const r = 0.96 + (rnd() - 0.5) * 0.035;
      const th = theta + (rnd() - 0.5) * 0.012;
      push(-Math.cos(th) * r, Math.sin(th) * Math.cos(alpha) * r, Math.sin(th) * Math.sin(alpha) * r, 'johan', 1.2 + rnd() * 0.9);
    }
  }
  // Mia: lado derecho, más suelta, repartida en volumen y con nodos algo mayores.
  for (let i = 0; i < nMia; i++) {
    const theta = rnd() * 1.25;
    const alpha = rnd() * Math.PI * 2;
    const r = 0.4 + 0.58 * Math.sqrt(rnd());
    push(Math.cos(theta) * r, Math.sin(theta) * Math.cos(alpha) * r, Math.sin(theta) * Math.sin(alpha) * r, 'mia', 1.4 + rnd() * 1.4);
  }
  // Rose: el interior y la zona inferior izquierda, con nodos medianos.
  for (let i = 0; i < nRose; i++) {
    const u = rnd(), v = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
    const r = 0.72 * Math.cbrt(u);
    const s2 = Math.sqrt(1 - v * v);
    const lower = rnd() < 0.4 ? 1 : 0;
    push(r * s2 * Math.cos(a) - 0.12 * lower, r * v + 0.12 * lower, r * s2 * Math.sin(a), 'rose', 1.8 + rnd() * rnd() * 2.8);
  }
  // Hubs con nombre (cada uno en el clúster de su hemisferio) y nodos amarillos, turquesa y lavanda de Nyvo.
  const hubIdx: number[] = [];
  for (const h of HUBS) {
    const dir = h.sec === 'johan' ? -1 : h.sec === 'mia' ? 1 : (rnd() < 0.5 ? -1 : 1);
    const theta = 0.2 + rnd() * 0.9, alpha = rnd() * Math.PI * 2;
    const r = h.sec === 'rose' ? 0.25 + rnd() * 0.4 : 0.7 + rnd() * 0.27;
    const rgb = h.sec === 'nyvo' ? NYVO_HUB_RGB[hubIdx.length % NYVO_HUB_RGB.length]! : undefined;
    hubIdx.push(nodes.length);
    push(dir * Math.cos(theta) * r, Math.sin(theta) * Math.cos(alpha) * r, Math.sin(theta) * Math.sin(alpha) * r, h.sec, 5 + rnd() * 2.2, rgb, h.label);
  }
  const nNyvoExtra = Math.max(8, Math.round(n * 0.02));
  for (let i = 0; i < nNyvoExtra; i++) {
    const v = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - v * v), r = 0.5 + rnd() * 0.47;
    push(r * s * Math.cos(a), r * v, r * s * Math.sin(a), 'nyvo', 2.6 + rnd() * 2, NYVO_HUB_RGB[i % NYVO_HUB_RGB.length]);
  }

  // Aristas: vecinos más cercanos dentro del clúster (pocos en Johan), puentes largos y los hubs enlazando clústeres.
  const edges: [number, number][] = [];
  const seen = new Set<number>();
  const link = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    if (seen.has(key)) return;
    seen.add(key); edges.push([a, b]);
  };
  const bySec: Record<Hemi, number[]> = { rose: [], johan: [], mia: [], nyvo: [] };
  nodes.forEach((nd, i) => bySec[nd.sec].push(i));
  const nearest = (i: number, pool: number[], k: number): number[] => {
    const a = nodes[i]!;
    return pool.filter(j => j !== i).map(j => [j, dist2(a, nodes[j]!)] as const).sort((p, q) => p[1] - q[1]).slice(0, k).map(p => p[0]);
  };
  nodes.forEach((nd, i) => {
    if (nd.sec === 'johan') { for (const j of nearest(i, bySec.johan, 1)) link(i, j); if (rnd() < 0.05) link(i, bySec.rose[Math.floor(rnd() * bySec.rose.length)]!); }
    else if (nd.sec === 'mia') { for (const j of nearest(i, bySec.mia, 2)) link(i, j); if (rnd() < 0.3) link(i, bySec.rose[Math.floor(rnd() * bySec.rose.length)]!); }
    else if (nd.sec === 'rose') { for (const j of nearest(i, bySec.rose, 2)) link(i, j); if (rnd() < 0.3) link(i, bySec.johan[Math.floor(rnd() * bySec.johan.length)]!); if (rnd() < 0.2) link(i, bySec.mia[Math.floor(rnd() * bySec.mia.length)]!); }
    else { for (const j of nearest(i, nodes.map((_, q) => q), 5)) link(i, j); }
  });
  const edgeSec = edges.map(([a]) => nodes[a]!.sec);
  const edgesBySec: Record<Hemi, number[]> = { rose: [], johan: [], mia: [], nyvo: [] };
  edgeSec.forEach((s, i) => edgesBySec[s].push(i));
  return { nodes, edges, edgeSec, edgesBySec, hubs: hubIdx };
}

export interface Targets { spin: number; ring: number; glow: number; pulseHz: number; reach: number; spawn: number }
/** Hacia dónde tiende la animación en cada estado (spawn = señales por segundo que recorren las aristas). */
export const TARGETS: Record<Mode, Targets> = {
  reposo:     { spin: 0.35, ring: 0.25, glow: 0.55, pulseHz: 0.25, reach: 0.00, spawn: 1.2 },
  escuchando: { spin: 0.45, ring: 0.45, glow: 0.75, pulseHz: 0.50, reach: 0.30, spawn: 3 },
  pensando:   { spin: 1.10, ring: 1.60, glow: 0.90, pulseHz: 1.60, reach: 0.10, spawn: 16 },
  hablando:   { spin: 0.55, ring: 0.60, glow: 1.00, pulseHz: 0.80, reach: 0.60, spawn: 7 }
};

export interface Pulse { edge: number; t: number; speed: number; sec: Hemi; dir: 1 | -1 }
export interface Wave { r: number; a: number }
const MAX_PULSES = 70;
const MAX_WAVES = 6;

export interface Dynamics {
  mode: Mode;
  yaw: number; ringPhase: number; clock: number;
  spin: number; ring: number; glow: number; pulseHz: number; reach: number; spawn: number;
  /** Nivel de audio suavizado 0..1. */
  level: number;
  /** Activación suavizada de cada sección 0..1 (0 = reposo). */
  act: Record<Hemi, number>;
  /** Sección que «recorre» el orbe mientras piensa sin herramienta activa. */
  sweep: number;
  pulses: Pulse[];
  waves: Wave[];
  spawnAcc: number;
  waveAcc: number;
}

export const createDynamics = (): Dynamics => ({
  mode: 'reposo', yaw: 0.2, ringPhase: 0, clock: 0, ...TARGETS.reposo, level: 0,
  act: { rose: 0, johan: 0, mia: 0, nyvo: 0 }, sweep: 0, pulses: [], waves: [], spawnAcc: 0, waveAcc: 0
});

/** Acerca x a su objetivo con constante de tiempo tau (independiente de los fps). */
export const approach = (x: number, target: number, dt: number, tau: number) => x + (target - x) * (1 - Math.exp(-dt / tau));

export interface StepInput { mode: Mode; sections: Record<Hemi, SectionMode>; level: number; reducedMotion?: boolean }

/** Avanza la dinámica dt segundos. Con «reducir movimiento» el giro, los pulsos y las señales se atenúan mucho. */
export function stepDynamics(d: Dynamics, dt: number, inp: StepInput, graph?: Graph, rnd: () => number = Math.random): void {
  dt = Math.min(dt, 0.1);   // si la pestaña estuvo en segundo plano, no dar un salto
  const t = TARGETS[inp.mode];
  const calm = inp.reducedMotion ? 0.25 : 1;
  d.mode = inp.mode;
  d.spin = approach(d.spin, t.spin * calm, dt, 0.6);
  d.ring = approach(d.ring, t.ring * calm, dt, 0.8);
  d.glow = approach(d.glow, t.glow, dt, 0.5);
  d.pulseHz = approach(d.pulseHz, t.pulseHz * calm, dt, 0.5);
  d.reach = approach(d.reach, t.reach, dt, 0.4);
  d.spawn = approach(d.spawn, t.spawn * calm, dt, 0.5);
  d.level = approach(d.level, inp.level, dt, inp.level > d.level ? 0.05 : 0.18);   // sube rápido, baja despacio
  d.yaw += d.spin * dt;
  d.ringPhase += d.ring * dt;
  d.clock += dt;

  const anyActive = SECTIONS.some(s => inp.sections[s] === 'activo');
  d.sweep = (d.sweep + dt / 1.2) % SECTIONS.length;
  for (const s of SECTIONS) {
    let target = inp.sections[s] === 'activo' ? 1 : inp.sections[s] === 'listo' ? 0.55 : 0;
    // Pensando sin herramienta: el brillo recorre los cuatro clústeres en orden.
    if (inp.mode === 'pensando' && !anyActive && !inp.reducedMotion) {
      const idx = SECTIONS.indexOf(s);
      const dist = Math.min(Math.abs(d.sweep - idx), SECTIONS.length - Math.abs(d.sweep - idx));
      target = Math.max(target, 0.85 - dist * 0.45);
    }
    d.act[s] = approach(d.act[s], target, dt, target > d.act[s] ? 0.18 : 0.45);
  }

  // Ondas desde el núcleo mientras hay voz (la tuya o la de Nyvo).
  d.waveAcc += dt;
  if ((inp.mode === 'hablando' || inp.mode === 'escuchando') && inp.level > 0.12 && d.waveAcc > 0.32 && d.waves.length < MAX_WAVES && !inp.reducedMotion) {
    d.waves.push({ r: 0.05, a: Math.min(1, inp.level * 1.4) }); d.waveAcc = 0;
  }
  for (const w of d.waves) { w.r += dt * 0.85; w.a -= dt * 0.9; }
  d.waves = d.waves.filter(w => w.a > 0);

  // Señales que recorren las aristas: más al pensar y concentradas en la sección que trabaja.
  if (graph && graph.edges.length) {
    d.spawnAcc += d.spawn * dt;
    while (d.spawnAcc >= 1 && d.pulses.length < MAX_PULSES) {
      d.spawnAcc -= 1;
      const active = SECTIONS.filter(s => d.act[s] > 0.4 && graph.edgesBySec[s].length);
      const pool = active.length && rnd() < 0.8 ? graph.edgesBySec[active[Math.floor(rnd() * active.length)]!] : null;
      const edge = pool ? pool[Math.floor(rnd() * pool.length)]! : Math.floor(rnd() * graph.edges.length);
      d.pulses.push({ edge, t: 0, speed: 0.5 + rnd() * 0.9, sec: graph.edgeSec[edge]!, dir: rnd() < 0.5 ? 1 : -1 });
    }
    if (d.spawnAcc > 1) d.spawnAcc = 1;
    for (const p of d.pulses) p.t += dt * p.speed;
    d.pulses = d.pulses.filter(p => p.t < 1);
  }
}

export interface Projected { sx: number; sy: number; depth: number }

/** Amplitud del balanceo en Y (rad): el grafo se mueve en 3D sin perder nunca la composición (el casquete naranja a la izquierda). */
export const SWING = 0.62;

/** Proyecta un nodo: balanceo en Y (d.yaw es la fase), inclinación suave que flota, deriva viva, perspectiva leve y empuje con la voz. */
export function project(p: GNode, d: Dynamics, out: Projected): Projected {
  const tilt = 0.2 + 0.08 * Math.sin(d.clock * 0.21);
  const yaw = SWING * Math.sin(d.yaw);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const px = p.x + 0.006 * Math.sin(p.seed + d.clock * 0.7), pz = p.z + 0.006 * Math.cos(p.seed * 1.7 + d.clock * 0.6);
  const x1 = px * cy + pz * sy;
  const z1 = -px * sy + pz * cy;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const y2 = p.y * ct - z1 * st;
  const z2 = p.y * st + z1 * ct;
  const push = 1 + d.level * d.reach * 0.07 * (0.5 + 0.5 * Math.sin(p.seed + d.clock * 5)) + 0.012 * Math.sin(d.clock * Math.PI * 2 * d.pulseHz + p.seed);
  const persp = 1 / (1 - z2 * 0.16);
  out.sx = x1 * push * persp;
  out.sy = y2 * push * persp;
  out.depth = z2 / RZ;   // -1 (atrás) .. 1 (delante)
  return out;
}
