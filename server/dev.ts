import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildDeps } from './app.js';
import { handle } from './http/routes.js';
import { SECURITY_HEADERS } from './http/http.js';
import { migrate } from './db/migrate.js';

/**
 * Servidor local: /api/* con el mismo enrutador que Vercel y, si existe, la web compilada (dist/).
 * Uso: npm run dev (API en :3001) + npm run dev:web (Vite en :5173 con proxy a /api).
 */
const PORT = Number(process.env.PORT ?? 3001);
const STATIC = path.resolve(process.env.STATIC_DIR ?? 'dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};

const deps = buildDeps();
if (deps && process.env.MIGRATE_ON_START === '1') await migrate(deps.db, console.log);

async function serveStatic(urlPath: string): Promise<{ body: Buffer; type: string; immutable: boolean } | null> {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(STATIC, clean);
  if (!file.startsWith(STATIC)) return null;
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(STATIC, 'index.html'); // SPA
  }
  try {
    return { body: await readFile(file), type: TYPES[path.extname(file)] ?? 'application/octet-stream', immutable: file.includes(`${path.sep}assets${path.sep}`) };
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/api/') || url === '/api') return handle(req, res, deps);
  const file = await serveStatic(url.split('?')[0]!);
  if (!file) { res.writeHead(404); return res.end('No encontrado'); }
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': file.type, 'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(file.body);
}).listen(PORT, () => console.log(`Nyvo (local) en http://localhost:${PORT}${deps ? '' : ' — falta DATABASE_URL'}`));
