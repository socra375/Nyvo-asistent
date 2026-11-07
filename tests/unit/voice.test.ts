import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vad, type VadEvent } from '../../web/src/voice/vad.js';
import { bytesToBase64, concat, downsample, encodeWav, PreRoll, rms } from '../../web/src/voice/wav.js';
import { chunkForSpeech } from '../../web/src/voice/chunker.js';
import { SpeechQueue, type Playing } from '../../web/src/voice/speechQueue.js';
import { stepConversation, type ConvEvent, type ConvState } from '../../web/src/voice/conversation.js';
import { approach, createDynamics, createParticles, project, sectionAt, sectionWeights, SECTIONS, stepDynamics, type Hemi, type SectionMode } from '../../web/src/orb/orbModel.js';

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
  const bad = fakeQueue({ failOn: 'b' });
  let reason = '', err: unknown;
  await bad.q.speak(['a', 'b'], { onEnd: (r, e) => { reason = r; err = e; } });
  assert.equal(reason, 'error');
  assert.match(String((err as Error).message), /fallo/);
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

test('orbe: cuatro secciones fijas con mezcla suave; pesos suman 1', () => {
  assert.deepEqual([...SECTIONS], ['rose', 'johan', 'mia', 'nyvo']);
  const at = (deg: number) => sectionAt((deg * Math.PI) / 180);
  assert.equal(at(-135), 'rose'); assert.equal(at(-45), 'johan'); assert.equal(at(45), 'mia'); assert.equal(at(135), 'nyvo');
  for (let deg = -180; deg < 180; deg += 7) {
    const w = sectionWeights((deg * Math.PI) / 180);
    assert.ok(Math.abs(SECTIONS.reduce((n, s) => n + w[s], 0) - 1) < 1e-9, `suma 1 en ${deg}°`);
  }
  const edge = sectionWeights(-Math.PI / 2);   // justo entre Rose y Johan
  assert.ok(Math.abs(edge.rose - 0.5) < 1e-9 && Math.abs(edge.johan - 0.5) < 1e-9);
});

test('orbe: partículas uniformes y deterministas; el giro mueve la esfera sin deformarla', () => {
  const a = createParticles(500, 3), b = createParticles(500, 3);
  assert.deepEqual(a[17], b[17]);
  assert.ok(a.every(p => Math.abs(Math.hypot(p.x, p.y, p.z) - 1) < 1e-9), 'todas sobre la esfera');
  const d = createDynamics();
  const p0 = project(a[40]!, d, { sx: 0, sy: 0, depth: 0, angle: 0 });
  const x0 = p0.sx, y0 = p0.sy;
  d.yaw = 1.2;
  const p1 = project(a[40]!, d, { sx: 0, sy: 0, depth: 0, angle: 0 });
  assert.ok(Math.hypot(p1.sx - x0, p1.sy - y0) > 0.05, 'al girar cambia de posición');
  assert.ok(Math.hypot(p1.sx, p1.sy) < 1.35, 'sigue dentro del orbe');
});

test('orbe: la dinámica es suave, depende del estado y respeta «reducir movimiento»', () => {
  const idle: Record<Hemi, SectionMode> = { rose: 'reposo', johan: 'reposo', mia: 'reposo', nyvo: 'reposo' };
  const run = (mode: 'reposo' | 'pensando' | 'hablando', secs = idle, seconds = 4, level = 0, reducedMotion = false) => {
    const d = createDynamics();
    for (let i = 0; i < seconds * 60; i++) stepDynamics(d, 1 / 60, { mode, sections: secs, level, reducedMotion });
    return d;
  };
  assert.ok(run('pensando').spin > run('reposo').spin * 3, 'pensando gira más rápido');
  assert.ok(run('pensando', idle, 4, 0, true).spin < run('pensando').spin * 0.4, 'reducir movimiento atenúa el giro');
  const johan = run('pensando', { ...idle, johan: 'activo' }, 2);
  assert.ok(johan.act.johan > 0.9 && johan.act.rose < 0.3, 'solo la sección activa se enciende');
  const speaking = run('hablando', idle, 2, 0.8);
  assert.ok(speaking.level > 0.7);
  assert.ok(Math.abs(approach(0, 1, 1, 1) - (1 - Math.exp(-1))) < 1e-12);
  const d = createDynamics();
  stepDynamics(d, 5, { mode: 'reposo', sections: idle, level: 0 });
  assert.ok(d.clock <= 0.1, 'un parón largo de la pestaña no da un salto');
  const sweep = run('pensando', idle, 1.3);
  assert.ok(SECTIONS.filter(s => sweep.act[s] > 0.5).length >= 1, 'pensando sin herramienta recorre las secciones');
});
