import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Vad, type VadEvent } from '../../web/src/voice/vad.js';
import { bytesToBase64, concat, downsample, encodeWav, PreRoll, rms } from '../../web/src/voice/wav.js';
import { chunkForSpeech } from '../../web/src/voice/chunker.js';
import { SpeechQueue, type Playing } from '../../web/src/voice/speechQueue.js';
import { stepConversation, type ConvEvent, type ConvState } from '../../web/src/voice/conversation.js';
import { approach, createDynamics, createGraph, HUBS, project, SECTIONS, SECTION_RGB, stepDynamics, waveShape, type Hemi, type SectionMode } from '../../web/src/orb/orbModel.js';

const BLOCK_MS = 21;
/** Alimenta el VAD con un nivel constante durante `ms` y devuelve los eventos con su instante. */
function drive(v: Vad, levels: [number, number][], out = false): { ev: VadEvent; at: number }[] {
  const events: { ev: VadEvent; at: number }[] = [];
  let t = 0;
  for (const [level, ms] of levels) for (let i = 0; i < Math.round(ms / BLOCK_MS); i++) { t += BLOCK_MS; const ev = v.feed(level, BLOCK_MS, out); if (ev) events.push({ ev, at: t }); }
  return events;
}

test('VAD: una frase empieza y termina; el ruido de fondo no cuenta', () => {
  const v = new Vad();
  const ev = drive(v, [[0.003, 800], [0.12, 900], [0.003, 1200]]);
  assert.deepEqual(ev.map(e => e.ev), ['start', 'end']);
  assert.ok(ev[0]!.at >= 800 && ev[0]!.at < 1050, 'detecta el inicio casi de inmediato');
  assert.ok(v.wasSpeech);
});

test('VAD: un golpe corto (clic) no es una frase', () => {
  const v = new Vad();
  const ev = drive(v, [[0.003, 800], [0.2, 40], [0.003, 1500]]);
  assert.deepEqual(ev, []);
});

test('VAD: una pausa breve dentro de la frase no la corta, una larga sí', () => {
  const v = new Vad();
  assert.deepEqual(drive(v, [[0.003, 800], [0.1, 600], [0.003, 400], [0.1, 600]]).map(e => e.ev), ['start']);
  assert.deepEqual(drive(v, [[0.003, 1000]]).map(e => e.ev), ['end']);
});

test('VAD: un zumbido constante se absorbe como ruido de fondo y no se toma por voz', () => {
  const v = new Vad();
  assert.deepEqual(drive(v, [[0.02, 6000]]), []);
  assert.deepEqual(drive(v, [[0.2, 700], [0.02, 1200]]).map(e => e.ev), ['start', 'end']);
});

test('VAD: interrupción exige más energía y más tiempo mientras Nyvo habla (el eco no interrumpe)', () => {
  const v = new Vad();
  drive(v, [[0.003, 800]]);
  assert.deepEqual(drive(v, [[0.02, 2000]], true), [], 'un eco débil no interrumpe');
  assert.deepEqual(drive(v, [[0.5, 60]], true), [], 'un pico corto tampoco');
  const ev = drive(v, [[0.2, 400]], true);
  assert.equal(ev[0]?.ev, 'start');
  assert.ok(v.barged, 'queda marcada como interrupción');
  // La misma energía sin que Nyvo hable sí es una frase normal.
  const w = new Vad();
  drive(w, [[0.003, 800]]);
  assert.equal(drive(w, [[0.02, 300]], false)[0]?.ev, 'start');
});

test('audio: rms, remuestreo a 16 kHz y WAV válido', () => {
  const tone = new Float32Array(48000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  assert.ok(Math.abs(rms(tone) - 0.3535) < 0.01);
  const down = downsample(tone, 48000, 16000);
  assert.equal(down.length, 16000);
  assert.ok(Math.abs(rms(down) - 0.35) < 0.05, 'conserva la energía');
  assert.equal(downsample(tone, 16000, 16000), tone);
  const wav = encodeWav(down, 16000);
  assert.equal(wav.length, 44 + 32000);
  const dv = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE');
  assert.equal(dv.getUint32(24, true), 16000);
  assert.equal(dv.getUint16(22, true), 1, 'mono');
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 32000);
  assert.equal(Buffer.from(bytesToBase64(wav), 'base64').length, wav.length);
  assert.equal(concat([new Float32Array(2), new Float32Array(3)]).length, 5);
});

test('pre-roll: conserva el comienzo de la frase que el VAD tardó en detectar', () => {
  const p = new PreRoll(1000);
  for (let i = 0; i < 20; i++) p.push(new Float32Array(100).fill(i));
  const kept = p.take();
  const total = kept.reduce((n, b) => n + b.length, 0);
  assert.ok(total >= 1000 && total < 1200, `conserva ~1000 muestras (${total})`);
  assert.equal(kept[kept.length - 1]![0], 19, 'lo más reciente se conserva');
  assert.deepEqual(p.take(), []);
});

test('troceado para voz: primer trozo corto, cortes en puntuación, nada se pierde', () => {
  const text = 'Tienes dos clientes activos. Laura Méndez debe cuatrocientos cincuenta dólares del sitio web de la cafetería, y el proyecto de Marco Ruiz sigue en revisión con entrega prevista para el viernes. ¿Quieres que prepare un recordatorio de cobro?';
  const chunks = chunkForSpeech(text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0]!.length <= 120, 'el primero es corto para empezar a hablar antes');
  assert.ok(chunks.every(c => c.length <= 260));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  assert.deepEqual(chunkForSpeech('   '), []);
  assert.deepEqual(chunkForSpeech('Hola.'), ['Hola.']);
  const long = chunkForSpeech('palabra '.repeat(100));
  assert.ok(long.every(c => c.length <= 260) && long.join(' ').split(' ').length === 100);
});

/** Audio falso: cada trozo «dura» lo que se le indique y se puede cortar. */
function fakeQueue(opts: { synthMs?: number; playMs?: number; failOn?: string } = {}) {
  const log: string[] = [];
  const q = new SpeechQueue<string>({
    prefetch: 2,
    synth: (text, signal) => new Promise((resolve, reject) => {
      log.push(`synth:${text}`);
      const t = setTimeout(() => (opts.failOn === text ? reject(new Error('fallo')) : resolve(text)), opts.synthMs ?? 5);
      signal.addEventListener('abort', () => { clearTimeout(t); log.push(`abort:${text}`); reject(new Error('abortado')); });
    }),
    play: (audio): Playing => {
      log.push(`play:${audio}`);
      let finish: () => void = () => undefined;
      const done = new Promise<void>(r => { finish = r; });
      const t = setTimeout(finish, opts.playMs ?? 20);
      return { done, stop: () => { clearTimeout(t); log.push(`stop:${audio}`); finish(); } };
    }
  });
  return { q, log };
}

test('cola de voz: lee en orden y sintetiza por adelantado', async () => {
  const { q, log } = fakeQueue();
  const ends: string[] = [];
  await q.speak(['a', 'b', 'c'], { onStart: () => ends.push('inicio'), onEnd: r => ends.push(r) });
  assert.deepEqual(log.filter(l => l.startsWith('play')), ['play:a', 'play:b', 'play:c']);
  assert.deepEqual(ends, ['inicio', 'fin']);
  assert.ok(log.indexOf('synth:b') < log.indexOf('play:a'), 'b ya se pidió antes de que empiece a sonar a');
  assert.equal(q.speaking, false);
});

test('cola de voz: cancel() corta lo que suena y aborta lo que está en camino (interrupción)', async () => {
  const { q, log } = fakeQueue({ playMs: 500, synthMs: 5 });
  const ends: string[] = [];
  const done = q.speak(['a', 'b', 'c', 'd'], { onEnd: r => ends.push(r) });
  await new Promise(r => setTimeout(r, 60));
  assert.ok(q.speaking);
  const t0 = performance.now();
  q.cancel();
  await done;
  assert.ok(performance.now() - t0 < 50, 'se detiene de inmediato, sin esperar al final del trozo');
  assert.ok(log.includes('stop:a'));
  assert.ok(!log.includes('play:b'), 'no empieza el siguiente trozo');
  assert.deepEqual(ends, ['cancelado']);
  assert.equal(q.speaking, false);
});

test('cola de voz: una lectura nueva cancela la anterior; un error de síntesis se informa', async () => {
  const { q } = fakeQueue({ playMs: 300 });
  const first: string[] = [];
  const p1 = q.speak(['a', 'b'], { onEnd: r => first.push(r) });
  await new Promise(r => setTimeout(r, 40));
  const second: string[] = [];
  await q.speak(['x'], { onEnd: r => second.push(r) });
  await p1;
  assert.deepEqual(first, ['cancelado']);
  assert.deepEqual(second, ['fin']);
  // Un trozo que el proveedor rechaza se salta: el resto de la respuesta sigue sonando
  const bad = fakeQueue({ failOn: 'b' });
  let reason = '';
  await bad.q.speak(['a', 'b', 'c'], { onEnd: r => { reason = r; } });
  assert.equal(reason, 'fin');
  assert.deepEqual(bad.log.filter(l => l.startsWith('play')), ['play:a', 'play:c']);
  // Si no suena nada, sí es un error (con el motivo)
  const all = fakeQueue({ failOn: 'a' });
  let r2 = '', err: unknown;
  await all.q.speak(['a'], { onEnd: (r, e) => { r2 = r; err = e; } });
  assert.equal(r2, 'error');
  assert.match(String((err as Error).message), /fallo/);
});

test('troceado: se descartan los trozos sin letras ni números', () => {
  const mixed = chunkForSpeech('Hola. … ¿? Adiós.');
  assert.ok(mixed.length >= 1 && mixed.every(c => /[\p{L}\p{N}]/u.test(c)));
  assert.match(mixed.join(' '), /Hola/); assert.match(mixed.join(' '), /Adiós/);
  for (const c of chunkForSpeech('… ¿? ¡! — Cobraste 450 dólares. ...')) assert.match(c, /[\p{L}\p{N}]/u);
  assert.deepEqual(chunkForSpeech('… ¿? !'), []);
});

test('conversación: flujo normal y estados', () => {
  const run = (state: ConvState, ...events: ConvEvent[]) => events.reduce<{ state: ConvState; actions: string[] }>((a, e) => { const s = stepConversation(a.state, e); return { state: s.state, actions: [...a.actions, ...s.actions] }; }, { state, actions: [] });
  let r = run('inactivo', { tipo: 'activar' });
  assert.deepEqual([r.state, r.actions], ['escuchando', ['abrir-microfono']]);
  r = run('escuchando', { tipo: 'voz-inicia', interrumpe: false }, { tipo: 'frase-lista' }, { tipo: 'respuesta-lista', hayVoz: true }, { tipo: 'voz-termina' });
  assert.equal(r.state, 'escuchando');
  assert.deepEqual(run('pensando', { tipo: 'respuesta-lista', hayVoz: false }).state, 'escuchando');
  assert.equal(run('pensando', { tipo: 'sin-texto' }).state, 'escuchando');
});

test('conversación: interrumpir a Nyvo corta la voz; cambiar de idea cancela la petición; desactivar lo apaga todo', () => {
  const a = stepConversation('hablando', { tipo: 'voz-inicia', interrumpe: true });
  assert.equal(a.state, 'escuchando');
  assert.deepEqual(a.actions, ['cortar-voz', 'empezar-frase']);
  const b = stepConversation('pensando', { tipo: 'voz-inicia', interrumpe: false });
  assert.deepEqual([b.state, b.actions], ['escuchando', ['cancelar-peticion', 'empezar-frase']]);
  const c = stepConversation('hablando', { tipo: 'desactivar' });
  assert.equal(c.state, 'inactivo');
  assert.deepEqual(c.actions, ['cortar-voz', 'cancelar-peticion', 'cerrar-microfono']);
  // Una respuesta que llega tarde (el usuario ya habló otra vez) se ignora.
  assert.equal(stepConversation('escuchando', { tipo: 'respuesta-lista', hayVoz: true }).state, 'escuchando');
  assert.equal(stepConversation('inactivo', { tipo: 'voz-inicia', interrumpe: false }).state, 'inactivo');
  assert.equal(stepConversation('inactivo', { tipo: 'error' }).state, 'inactivo');
});

test('orbe: grafo con cuatro clústeres, hubs con nombre y aristas válidas', () => {
  assert.deepEqual([...SECTIONS], ['rose', 'johan', 'mia', 'nyvo']);
  const g = createGraph(900);
  const count = (s: Hemi) => g.nodes.filter(n => n.sec === s).length;
  for (const s of SECTIONS) assert.ok(count(s) >= 10, `${s} tiene nodos`);
  assert.ok(count('johan') > count('mia'), 'Johan es el casquete denso');
  assert.deepEqual(g.hubs.map(i => g.nodes[i]!.label), HUBS.map(h => h.label), 'cada hub lleva su nombre');
  g.hubs.forEach((i, k) => assert.equal(g.nodes[i]!.sec, HUBS[k]!.sec));
  assert.ok(g.edges.length > g.nodes.length, 'red densa: más aristas que nodos');
  const keys = new Set<string>();
  for (const [a, b] of g.edges) {
    assert.ok(a !== b && g.nodes[a] && g.nodes[b]);
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    assert.ok(!keys.has(k), 'sin aristas repetidas'); keys.add(k);
  }
  assert.equal(SECTIONS.reduce((n, s) => n + g.edgesBySec[s].length, 0), g.edges.length);
  // Los clústeres ocupan su lado: Johan a la izquierda, Mia a la derecha.
  const mean = (s: Hemi) => g.nodes.filter(n => n.sec === s).reduce((a, n) => a + n.x, 0) / count(s);
  assert.ok(mean('johan') < -0.4 && mean('mia') > 0.2, 'Johan a la izquierda y Mia a la derecha');
  // Naranja, azul y rosa distintos
  assert.notDeepEqual(SECTION_RGB.johan, SECTION_RGB.mia);
});

test('orbe: determinista, dentro del encuadre, y el giro mueve el grafo', () => {
  const a = createGraph(500, 3), b = createGraph(500, 3);
  assert.deepEqual(a.nodes[40], b.nodes[40]);
  assert.deepEqual(a.edges.slice(0, 50), b.edges.slice(0, 50));
  const d = createDynamics();
  const out = { sx: 0, sy: 0, depth: 0 };
  for (const nd of a.nodes) {
    project(nd, d, out);
    assert.ok(Number.isFinite(out.sx) && Number.isFinite(out.sy));
    assert.ok(Math.abs(out.sx) < 1.4 && Math.abs(out.sy) < 1.1, 'dentro del encuadre');
    assert.ok(out.depth >= -1.2 && out.depth <= 1.2);
  }
  project(a.nodes[40]!, d, out);
  const x0 = out.sx, y0 = out.sy;
  d.yaw += 1.2;
  project(a.nodes[40]!, d, out);
  assert.ok(Math.hypot(out.sx - x0, out.sy - y0) > 0.05, 'al girar cambia de posición');
});

test('orbe: gira 360° completos: tras 2π vuelve al mismo sitio y a media vuelta el casquete pasa al otro lado', () => {
  const g = createGraph(500, 5);
  const out = { sx: 0, sy: 0, depth: 0 };
  const at = (yaw: number) => {
    const d = createDynamics(); d.yaw = yaw;
    return g.nodes.map(nd => { const p = project(nd, d, { ...out }); return [p.sx, p.sy, p.depth] as const; });
  };
  const a = at(0.7), b = at(0.7 + 2 * Math.PI);
  a.forEach((p, i) => { assert.ok(Math.abs(p[0] - b[i]![0]) < 1e-9 && Math.abs(p[1] - b[i]![1]) < 1e-9, 'periodo 2π'); });
  // Johan (casquete a la izquierda) pasa a la derecha a media vuelta, y el centro de Mia a la izquierda.
  const mean = (pts: (readonly number[])[], sec: string) => { const idx = g.nodes.map((n, i) => (n.sec === sec ? i : -1)).filter(i => i >= 0); return idx.reduce((s, i) => s + pts[i]![0]!, 0) / idx.length; };
  const front = at(0), back = at(Math.PI);
  assert.ok(mean(front, 'johan') < -0.4 && mean(back, 'johan') > 0.4, 'Johan cruza de izquierda a derecha');
  assert.ok(mean(front, 'mia') > 0.2 && mean(back, 'mia') < -0.2, 'Mia cruza de derecha a izquierda');
  // El giro es continuo: avanzar el tiempo suma ángulo sin tope (no oscila)
  const d = createDynamics();
  const idle: Record<Hemi, SectionMode> = { rose: 'reposo', johan: 'reposo', mia: 'reposo', nyvo: 'reposo' };
  const y0 = d.yaw;
  for (let i = 0; i < 60 * 25; i++) stepDynamics(d, 1 / 60, { mode: 'reposo', sections: idle, level: 0 });
  assert.ok(d.yaw - y0 > 2 * Math.PI, `en 25 s en reposo da más de una vuelta (${(d.yaw - y0).toFixed(1)} rad)`);
});

test('orbe: la dinámica es suave, depende del estado, respeta «reducir movimiento» y las señales están acotadas', () => {
  const g = createGraph(500);
  const idle: Record<Hemi, SectionMode> = { rose: 'reposo', johan: 'reposo', mia: 'reposo', nyvo: 'reposo' };
  const run = (mode: 'reposo' | 'pensando' | 'hablando', secs = idle, seconds = 4, level = 0, reducedMotion = false) => {
    const d = createDynamics();
    for (let i = 0; i < seconds * 60; i++) stepDynamics(d, 1 / 60, { mode, sections: secs, level, reducedMotion }, g);
    return d;
  };
  assert.ok(run('pensando').spin > run('reposo').spin * 3, 'pensando gira más rápido');
  assert.ok(run('pensando', idle, 4, 0, true).spin < run('pensando').spin * 0.4, 'reducir movimiento atenúa el giro');
  const johan = run('pensando', { ...idle, johan: 'activo' }, 2);
  assert.ok(johan.act.johan > 0.9 && johan.act.rose < 0.3, 'solo la sección activa se enciende');
  assert.ok(run('hablando', idle, 2, 0.8).level > 0.7);
  assert.ok(Math.abs(approach(0, 1, 1, 1) - (1 - Math.exp(-1))) < 1e-12);
  const d0 = createDynamics();
  stepDynamics(d0, 5, { mode: 'reposo', sections: idle, level: 0 }, g);
  assert.ok(d0.clock <= 0.1, 'un parón largo de la pestaña no da un salto');
  const thinking = run('pensando', idle, 3);
  assert.ok(thinking.pulses.length > 0 && thinking.pulses.length <= 70, 'hay señales viajando, acotadas');
  assert.ok(thinking.pulses.every(p => p.edge < g.edges.length && p.t >= 0 && p.t < 1));
  assert.ok(run('pensando', idle, 3, 0, true).pulses.length < thinking.pulses.length, 'con menos movimiento, menos señales');
  // Con una sección activa, las señales se concentran en sus aristas
  const focused = run('pensando', { ...idle, mia: 'activo' }, 3);
  const inMia = focused.pulses.filter(p => p.sec === 'mia').length;
  assert.ok(inMia >= focused.pulses.length * 0.5, `la mayoría en Mia (${inMia}/${focused.pulses.length})`);
  const sweep = run('pensando', idle, 1.3);
  assert.ok(SECTIONS.filter(s => sweep.act[s] > 0.4).length >= 1, 'pensando sin herramienta recorre los clústeres');
  const speaking = run('hablando', idle, 2, 0.8);
  assert.ok(speaking.waves.length > 0 && speaking.waves.length <= 3, 'anillos desde el núcleo al hablar, pocos a la vez');
});

describe('escuchar y hablar: suaves y distintos', () => {
  const g = createGraph(300);
  const idle: Record<Hemi, SectionMode> = { rose: 'reposo', johan: 'reposo', mia: 'reposo', nyvo: 'reposo' };
  const FPS = 1 / 60;
  const run = (mode: 'escuchando' | 'hablando' | 'reposo', seconds: number, level: (i: number) => number, d = createDynamics()) => {
    for (let i = 0; i < seconds * 60; i++) stepDynamics(d, FPS, { mode, sections: idle, level: level(i) }, g);
    return d;
  };

  test('un pico de audio de un fotograma casi no mueve el orbe', () => {
    const d = createDynamics();
    stepDynamics(d, FPS, { mode: 'hablando', sections: idle, level: 1 }, g);
    assert.ok(d.level < 0.12, `nivel tras un fotograma a tope: ${d.level.toFixed(3)}`);
    assert.ok(Math.abs(d.swell) < 0.002);
  });

  test('un micrófono ruidoso (0/1 alternando cada fotograma) no hace temblar nada', () => {
    for (const mode of ['escuchando', 'hablando'] as const) {
      const d = run(mode, 2, () => 0.5);
      const levels: number[] = [], swells: number[] = [];
      for (let i = 0; i < 60; i++) { stepDynamics(d, FPS, { mode, sections: idle, level: i % 2 ? 1 : 0 }, g); levels.push(d.level); swells.push(d.swell); }
      const p2p = (a: number[]) => Math.max(...a) - Math.min(...a);
      assert.ok(p2p(levels) < 0.12, `${mode}: el nivel oscila ${p2p(levels).toFixed(3)}`);
      assert.ok(p2p(swells) < 0.004, `${mode}: la respiración oscila ${p2p(swells).toFixed(4)}`);
    }
  });

  test('escuchar inhala (se recoge, anillos que entran, tono frío); hablar exhala (se expande, anillos que salen, tono cálido)', () => {
    const listen = run('escuchando', 4, () => 0.6);
    const speak = run('hablando', 4, () => 0.6);
    assert.ok(listen.swell < 0 && speak.swell > 0, 'direcciones opuestas');
    assert.ok(Math.abs(listen.swell) <= 0.03 && speak.swell <= 0.04, 'amplitud pequeña');
    assert.ok(listen.mood < 0.05 && speak.mood > 0.9, 'frío al escuchar, cálido al hablar');
    assert.ok(listen.waves.length > 0 && listen.waves.every(w => w.dir === -1));
    assert.ok(speak.waves.length > 0 && speak.waves.every(w => w.dir === 1));
    assert.ok(speak.spin > listen.spin, 'hablando gira algo más que escuchando');
  });

  test('el cambio de tono entre escuchar y hablar es gradual', () => {
    const d = run('hablando', 3, () => 0.6);
    const before = d.mood;
    stepDynamics(d, FPS, { mode: 'escuchando', sections: idle, level: 0.6 }, g);
    assert.ok(before - d.mood < 0.05, 'en un fotograma cambia muy poco');
    run('escuchando', 3, () => 0.6, d);
    assert.ok(d.mood < 0.05, 'y al final queda frío');
  });

  test('los anillos aparecen y se apagan con suavidad; salen o entran según su dirección', () => {
    for (const dir of [1, -1] as const) {
      assert.equal(waveShape({ t: 0, amp: 1, dir }).alpha, 0);
      assert.ok(Math.abs(waveShape({ t: 1, amp: 1, dir }).alpha) < 1e-9);
      const mid = waveShape({ t: 0.5, amp: 1, dir });
      assert.ok(mid.alpha > 0.2 && mid.alpha <= 0.28, 'discretos: nunca más de 0,28 de opacidad');
    }
    assert.ok(waveShape({ t: 0.8, amp: 1, dir: 1 }).r > waveShape({ t: 0.2, amp: 1, dir: 1 }).r, 'al hablar crece');
    assert.ok(waveShape({ t: 0.8, amp: 1, dir: -1 }).r < waveShape({ t: 0.2, amp: 1, dir: -1 }).r, 'al escuchar se encoge');
  });

  test('sin movimiento (preferencia del sistema): no hay anillos y la respiración se reduce', () => {
    const d = createDynamics();
    for (let i = 0; i < 4 * 60; i++) stepDynamics(d, FPS, { mode: 'hablando', sections: idle, level: 0.8, reducedMotion: true }, g);
    assert.equal(d.waves.length, 0);
    const full = run('hablando', 4, () => 0.8);
    assert.ok(d.swell < full.swell * 0.5);
  });

  test('el nivel de audio ya no entra por nodo: con la misma respiración global, el nivel no cambia ninguna posición (sin temblor por punto)', () => {
    const a = run('hablando', 3, () => 0.8);
    const b = { ...a, level: 0, waves: [], pulses: [] };
    const pa = { sx: 0, sy: 0, depth: 0 }, pb = { sx: 0, sy: 0, depth: 0 };
    for (const n of g.nodes.slice(0, 120)) {
      project(n, a, pa); project(n, b, pb);
      assert.equal(pa.sx, pb.sx); assert.equal(pa.sy, pb.sy);
    }
    // y la respiración global sí mueve a todos en el mismo sentido (hablando: se alejan del centro)
    const quiet = { ...a, swell: 0 };
    const out = g.nodes.slice(0, 120).filter(n => { project(n, a, pa); project(n, quiet, pb); return Math.hypot(pa.sx, pa.sy) >= Math.hypot(pb.sx, pb.sy); }).length;
    assert.equal(out, 120);
  });
});
