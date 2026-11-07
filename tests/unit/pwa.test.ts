import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const PUBLIC = path.resolve('web/public');
const read = (f: string) => readFileSync(path.join(PUBLIC, f));

/** Ancho y alto de un PNG leyendo su cabecera IHDR (sin dependencias). */
function pngSize(buf: Buffer): { w: number; h: number } {
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', 'no es un PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

interface Icon { src: string; sizes: string; type: string; purpose?: string }
const manifest = JSON.parse(read('manifest.webmanifest').toString('utf8')) as Record<string, unknown> & { icons: Icon[] };

test('PWA: el manifest tiene lo necesario para poder instalarse', () => {
  assert.equal(manifest.name, 'Nyvo · AINova System');
  assert.equal(manifest.short_name, 'Nyvo');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(String(manifest.theme_color), /^#[0-9a-f]{6}$/i);
  assert.match(String(manifest.background_color), /^#[0-9a-f]{6}$/i);
});

test('PWA: los iconos del manifest existen, son PNG y miden lo que declaran', () => {
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    const file = icon.src.replace(/^\//, '');
    assert.ok(existsSync(path.join(PUBLIC, file)), `falta ${file}`);
    const { w, h } = pngSize(read(file));
    assert.equal(`${w}x${h}`, icon.sizes, `${file} declara ${icon.sizes} pero mide ${w}x${h}`);
  }
});

test('PWA: hay iconos 192 y 512 normales y uno «maskable» de 512', () => {
  const has = (sizes: string, purpose: string) => manifest.icons.some(i => i.sizes === sizes && (i.purpose ?? 'any') === purpose);
  assert.ok(has('192x192', 'any'), 'falta icono 192 «any»');
  assert.ok(has('512x512', 'any'), 'falta icono 512 «any»');
  assert.ok(has('512x512', 'maskable'), 'falta icono 512 «maskable»');
  // Un solo propósito por icono (combinar «any maskable» hace que Android recorte mal el normal).
  for (const i of manifest.icons) assert.ok(!/\s/.test(i.purpose ?? 'any'), `${i.src} mezcla propósitos`);
});

test('iconos sueltos: favicon, apple-touch-icon y logos de la interfaz', () => {
  assert.deepEqual(pngSize(read('apple-touch-icon.png')), { w: 180, h: 180 });
  assert.deepEqual(pngSize(read('favicon-32.png')), { w: 32, h: 32 });
  assert.deepEqual(pngSize(read('logo-96.png')), { w: 96, h: 96 });
  assert.deepEqual(pngSize(read('logo-256.png')), { w: 256, h: 256 });
  // favicon.ico: cabecera ICO válida con 3 tamaños (16, 32 y 48).
  const ico = read('favicon.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
});

test('index.html enlaza manifest, favicon y apple-touch-icon, y ya no usa el favicon antiguo', () => {
  const html = readFileSync('web/index.html', 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<link rel="icon" href="\/favicon\.ico"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  assert.match(html, /<meta name="theme-color"/);
  assert.doesNotMatch(html, /favicon\.svg/);
  assert.ok(!existsSync(path.join(PUBLIC, 'favicon.svg')), 'el favicon.svg antiguo debe borrarse');
});

test('vercel.json: la regla de la SPA no se come el manifest ni los iconos', () => {
  const cfg = JSON.parse(readFileSync('vercel.json', 'utf8')) as { rewrites: { source: string; destination: string }[] };
  const spa = cfg.rewrites.find(r => r.destination === '/index.html')!;
  const re = new RegExp(`^${spa.source}$`);
  for (const p of ['/manifest.webmanifest', '/icon-192.png', '/icon-maskable-512.png', '/apple-touch-icon.png', '/favicon.ico', '/logo-96.png', '/assets/index-abc.js', '/api/health']) {
    assert.equal(re.test(p), false, `${p} no debe reescribirse a index.html`);
  }
  for (const p of ['/', '/conectores', '/memoria']) assert.ok(re.test(p), `${p} debe servir la SPA`);
});
