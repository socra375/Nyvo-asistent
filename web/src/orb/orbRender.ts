import { SECTIONS, SECTION_RGB, project, waveShape, type Dynamics, type Graph, type Projected, type RGB } from './orbModel';

const scratch: Projected = { sx: 0, sy: 0, depth: 0 };
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const TEAL: RGB = [70, 190, 200];
const WARM: RGB = [236, 150, 128];   // tono cálido al hablar
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Posiciones proyectadas en píxeles (se reutilizan entre fotogramas).
let PX = new Float32Array(0), PY = new Float32Array(0), PZ = new Float32Array(0);

/** Dibuja un fotograma del grafo. w y h en píxeles CSS (el contexto ya está escalado por el DPR). */
export function drawOrb(c: CanvasRenderingContext2D, w: number, h: number, d: Dynamics, g: Graph): void {
  c.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const S = Math.min(w / 2.06, h / 1.62);   // píxeles por unidad de escena
  const U = S / 300;                       // escala de tamaños de puntos y texto
  const n = g.nodes.length;
  if (PX.length < n) { PX = new Float32Array(n); PY = new Float32Array(n); PZ = new Float32Array(n); }
  for (let i = 0; i < n; i++) {
    project(g.nodes[i]!, d, scratch);
    PX[i] = cx + scratch.sx * S; PY[i] = cy + scratch.sy * S; PZ[i] = scratch.depth;
  }

  // Brillo del centro: frío (turquesa) al escuchar, cálido al hablar; el cambio es gradual
  const tone = mix(TEAL, WARM, d.mood);
  const pulse = 0.5 + 0.5 * Math.sin(d.clock * Math.PI * 2 * d.pulseHz);
  const glowR = S * (0.46 + 0.035 * pulse * d.glow + d.level * 0.1);
  const glow = c.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  glow.addColorStop(0, rgba(tone, 0.24 + d.glow * 0.1 + d.level * 0.06));
  glow.addColorStop(0.55, rgba(mix([40, 120, 140], [150, 80, 90], d.mood), 0.12 + d.glow * 0.04));
  glow.addColorStop(1, rgba(mix([40, 120, 140], [150, 80, 90], d.mood), 0));
  c.fillStyle = glow;
  c.fillRect(0, 0, w, h);

  // Elipses tenues alrededor, como órbitas que giran despacio
  c.lineWidth = 1;
  for (let k = 0; k < 3; k++) {
    c.save();
    c.translate(cx, cy);
    c.rotate(-0.25 + k * 0.5 + d.yaw * 0.05 * (k % 2 ? -1 : 1));
    c.strokeStyle = `rgba(190, 215, 230, ${0.05 + k * 0.012})`;
    c.beginPath();
    c.ellipse(0, 0, S * (1.04 + k * 0.05), S * (0.72 + k * 0.05), 0, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  // Aristas: todas en gris azulado muy fino; las de la sección que trabaja se encienden con su color
  c.lineWidth = Math.max(0.5, 0.7 * U * 1.3);
  c.strokeStyle = 'rgba(160, 185, 205, 0.075)';
  c.beginPath();
  for (const [a, b] of g.edges) { c.moveTo(PX[a]!, PY[a]!); c.lineTo(PX[b]!, PY[b]!); }
  c.stroke();
  for (const s of SECTIONS) {
    const a = d.act[s];
    if (a < 0.2) continue;
    c.strokeStyle = rgba(SECTION_RGB[s], 0.08 + a * 0.36);
    c.lineWidth = Math.max(0.6, 0.9 * U * 1.3);
    c.beginPath();
    // Solo las aristas internas del clúster: los puentes largos entre secciones no se encienden (se verían como una telaraña).
    for (const e of g.edgesBySec[s]) { const [p, q] = g.edges[e]!; if (g.nodes[q]!.sec !== s) continue; c.moveTo(PX[p]!, PY[p]!); c.lineTo(PX[q]!, PY[q]!); }
    c.stroke();
  }

  // Señales que viajan por las aristas
  for (const p of d.pulses) {
    const [a, b] = g.edges[p.edge]!;
    const t = p.dir === 1 ? p.t : 1 - p.t;
    const x = PX[a]! + (PX[b]! - PX[a]!) * t, y = PY[a]! + (PY[b]! - PY[a]!) * t;
    const fade = Math.sin(Math.PI * p.t);
    c.fillStyle = rgba(SECTION_RGB[p.sec], 0.15 + 0.8 * fade);
    c.beginPath(); c.arc(x, y, Math.max(1.4, 2.2 * U * 1.3), 0, Math.PI * 2); c.fill();
  }

  // Nodos: primero los de atrás (más tenues), luego los de delante
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const nd = g.nodes[i]!;
      const z = PZ[i]!;
      if ((z >= 0) !== (pass === 1)) continue;
      const act = d.act[nd.sec];
      const depth01 = (z + 1) / 2;
      const alpha = (0.5 + 0.5 * depth01) * Math.min(1, 0.85 + 0.6 * act);
      const size = nd.size * U * (0.62 + 0.55 * depth01) * (1 + 0.45 * act) * 1.15;
      const x = PX[i]!, y = PY[i]!;
      if (nd.label || nd.size > 4) {   // halo suave de los hubs
        c.fillStyle = rgba(nd.rgb, (0.05 + 0.2 * act) * alpha);
        c.beginPath(); c.arc(x, y, size * 1.9, 0, Math.PI * 2); c.fill();
      }
      c.fillStyle = rgba(nd.rgb, alpha);
      if (size < 1.5) c.fillRect(x - size / 2, y - size / 2, Math.max(1, size), Math.max(1, size));
      else { c.beginPath(); c.arc(x, y, size / 2 + 0.3, 0, Math.PI * 2); c.fill(); }
    }
  }

  // Etiquetas de los hubs (blanco con contorno oscuro, como la referencia); solo los que miran hacia delante
  c.font = `${Math.max(9, Math.round(10 * U * 1.2))}px Inter, system-ui, sans-serif`;
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  // Sin solapes: cada etiqueta se dibuja solo si no pisa a otra ni al núcleo (las más activas primero).
  const boxes: [number, number, number, number][] = [[cx - S * 0.12, cy - S * 0.12, S * 0.24, S * 0.24]];
  const order = [...g.hubs].sort((a, b) => d.act[g.nodes[b]!.sec] - d.act[g.nodes[a]!.sec] || PZ[b]! - PZ[a]!);
  for (const i of order) {
    const nd = g.nodes[i]!;
    const z = PZ[i]!;
    if (!nd.label || z < -0.25) continue;
    const act = d.act[nd.sec];
    const a = Math.min(1, (z + 0.25) * 1.3) * (0.72 + 0.28 * act);
    const size = nd.size * U * 1.15;
    const tw = c.measureText(nd.label).width, th = 14 * U * 1.2;
    const box: [number, number, number, number] = [PX[i]! + size + 3, PY[i]! - th / 2, tw + 2, th];
    if (boxes.some(o => box[0] < o[0] + o[2] && box[0] + box[2] > o[0] && box[1] < o[1] + o[3] && box[1] + box[3] > o[1])) continue;
    boxes.push(box);
    c.lineWidth = 3;
    c.strokeStyle = `rgba(2, 8, 14, ${0.75 * a})`;
    c.strokeText(nd.label, PX[i]! + size + 4, PY[i]!);
    c.fillStyle = `rgba(255, 255, 255, ${0.92 * a})`;
    c.fillText(nd.label, PX[i]! + size + 4, PY[i]!);
  }

  // Anillos suaves: salen del núcleo al hablar (cálidos) y entran hacia él al escuchar (fríos); doble trazo para que se difuminen
  for (const wv of d.waves) {
    const { r, alpha } = waveShape(wv);
    const col = wv.dir > 0 ? WARM : TEAL;
    c.strokeStyle = rgba(col, alpha * 0.3); c.lineWidth = 5 * Math.max(1, U * 1.3);
    c.beginPath(); c.arc(cx, cy, r * S, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = rgba(col, alpha); c.lineWidth = 1.2 * Math.max(1, U * 1.3);
    c.beginPath(); c.arc(cx, cy, r * S, 0, Math.PI * 2); c.stroke();
  }

  // Núcleo: anillo, arco que gira y punto central
  const cr = S * 0.045;
  c.strokeStyle = rgba([150, 240, 235], 0.85);
  c.lineWidth = Math.max(1, 1.3 * U * 1.3);
  c.beginPath(); c.arc(cx, cy, cr, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = rgba(TEAL, 0.7);
  c.setLineDash([3 * U * 1.3, 4 * U * 1.3]);
  c.beginPath(); c.arc(cx, cy, cr * 1.65, d.ringPhase, d.ringPhase + Math.PI * 2); c.stroke();
  c.setLineDash([]);
  c.strokeStyle = rgba([200, 255, 250], 0.9);
  c.beginPath(); c.arc(cx, cy, cr * 2.3, d.ringPhase * 1.4, d.ringPhase * 1.4 + 1.1 + d.level * 0.5); c.stroke();
  c.fillStyle = rgba([240, 100, 160], 0.95);
  c.beginPath(); c.arc(cx, cy, cr * (0.36 + 0.14 * pulse * d.glow + d.level * 0.22), 0, Math.PI * 2); c.fill();
}
