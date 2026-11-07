import { SECTIONS, SECTION_CENTER, SECTION_RGB, project, sectionWeights, type Dynamics, type Hemi, type Particle, type Projected } from './orbModel';

const GOLD = [255, 214, 120] as const;
const scratch: Projected = { sx: 0, sy: 0, depth: 0, angle: 0 };
const rgba = (r: number, g: number, b: number, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(3)})`;

/** Anillos discontinuos que giran a distinta velocidad y en sentidos opuestos, como en la referencia. */
const RINGS = [
  { r: 1.16, dash: [2, 9], speed: 1.0, width: 1.2, alpha: 0.55 },
  { r: 1.34, dash: [16, 10], speed: -0.65, width: 1.0, alpha: 0.4 },
  { r: 1.54, dash: [1, 7], speed: 0.4, width: 1.4, alpha: 0.3 }
] as const;

/** Dibuja un fotograma del orbe. w y h en píxeles CSS (el contexto ya está escalado por el DPR). */
export function drawOrb(c: CanvasRenderingContext2D, w: number, h: number, d: Dynamics, particles: readonly Particle[]): void {
  c.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) * 0.285;
  const unit = R / 160;

  // Halo general
  c.globalCompositeOperation = 'lighter';
  const halo = c.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.9);
  halo.addColorStop(0, rgba(...GOLD, 0.10 + d.glow * 0.08));
  halo.addColorStop(1, rgba(...GOLD, 0));
  c.fillStyle = halo;
  c.fillRect(0, 0, w, h);

  // Anillos discontinuos
  for (const ring of RINGS) {
    c.save();
    c.translate(cx, cy);
    c.rotate(d.ringPhase * ring.speed + d.clock * 0.02 * ring.speed);
    c.setLineDash(ring.dash.map(v => v * unit * 1.6));
    c.lineWidth = ring.width * Math.max(1, unit * 1.4);
    c.strokeStyle = rgba(...GOLD, ring.alpha * (0.6 + d.glow * 0.5));
    c.beginPath();
    c.arc(0, 0, R * ring.r, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
  c.setLineDash([]);

  // Divisiones de las cuatro secciones (cruz fina) y arco brillante de la sección activa sobre el anillo exterior
  c.strokeStyle = rgba(...GOLD, 0.16);
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(cx - R * 1.62, cy); c.lineTo(cx + R * 1.62, cy);
  c.moveTo(cx, cy - R * 1.62); c.lineTo(cx, cy + R * 1.62);
  c.stroke();
  for (const s of SECTIONS) {
    const a = d.act[s];
    if (a < 0.25) continue;
    const [r, g, b] = SECTION_RGB[s];
    const mid = SECTION_CENTER[s];
    c.strokeStyle = rgba(r, g, b, Math.min(0.95, (a - 0.2) * 1.1));
    c.lineWidth = Math.max(2, unit * 3);
    c.lineCap = 'round';
    c.beginPath();
    c.arc(cx, cy, R * 1.74, mid - Math.PI / 4 + 0.08, mid + Math.PI / 4 - 0.08);
    c.stroke();
  }

  // Cuerpo de la esfera: velo dorado con borde más claro, para que lea como esfera y no como una nube
  const body = c.createRadialGradient(cx, cy, R * 0.15, cx, cy, R * 1.08);
  body.addColorStop(0, rgba(...GOLD, 0.05));
  body.addColorStop(0.8, rgba(...GOLD, 0.07 + d.glow * 0.04));
  body.addColorStop(0.96, rgba(...GOLD, 0.22 + d.glow * 0.1));
  body.addColorStop(1, rgba(...GOLD, 0));
  c.fillStyle = body;
  c.beginPath(); c.arc(cx, cy, R * 1.08, 0, Math.PI * 2); c.fill();

  // Partículas: primero las de atrás, luego las de delante
  for (let pass = 0; pass < 2; pass++) {
    for (const p of particles) {
      project(p, d, scratch);
      const front = scratch.depth >= 0;
      if (front !== (pass === 1)) continue;
      const wts = sectionWeights(scratch.angle);
      let r = 0, g = 0, b = 0, act = 0;
      for (const s of SECTIONS) {
        const wt = wts[s as Hemi];
        const col = SECTION_RGB[s];
        r += col[0] * wt; g += col[1] * wt; b += col[2] * wt;
        act += d.act[s] * wt;
      }
      const depth01 = (scratch.depth + 1) / 2;
      const alpha = Math.min(1, (0.30 + 0.70 * depth01) * (0.55 + 0.75 * act) * (0.85 + 0.15 * Math.sin(d.clock * 2 + p.seed)));
      const size = p.size * unit * 1.45 * (0.7 + 0.6 * depth01) * (1 + act * 0.5 + d.level * 0.4);
      const x = cx + scratch.sx * R, y = cy + scratch.sy * R;
      c.fillStyle = rgba(r, g, b, alpha);
      if (size < 1.3) c.fillRect(x - size / 2, y - size / 2, Math.max(1, size), Math.max(1, size));
      else { c.beginPath(); c.arc(x, y, size / 2 + 0.2, 0, Math.PI * 2); c.fill(); }
    }
  }

  // Núcleo luminoso: late más rápido al pensar y se ensancha con la voz
  const pulse = 0.5 + 0.5 * Math.sin(d.clock * Math.PI * 2 * d.pulseHz);
  const coreR = R * (0.20 + 0.07 * pulse * d.glow + d.level * 0.16);
  const core = c.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.8);
  core.addColorStop(0, rgba(255, 250, 220, Math.min(1, 0.6 + d.glow * 0.35 + d.level * 0.3)));
  core.addColorStop(0.35, rgba(255, 214, 120, 0.28 + d.glow * 0.2));
  core.addColorStop(1, rgba(255, 190, 80, 0));
  c.fillStyle = core;
  c.beginPath(); c.arc(cx, cy, coreR * 1.8, 0, Math.PI * 2); c.fill();
  c.globalCompositeOperation = 'source-over';
}
