import { waitUntil } from '@vercel/functions';
import { loadConfig, type Env } from './config.js';
import { getDb } from './db/pool.js';
import { buildLlm } from './llm/build.js';
import type { Deps } from './deps.js';

/** Construye las dependencias reales a partir de las variables de entorno. Devuelve null si falta DATABASE_URL. */
export function buildDeps(env: Env = process.env, fetchImpl: typeof fetch = fetch): Deps | null {
  const cfg = loadConfig(env);
  if (!cfg.databaseUrl) return null;
  const llm = buildLlm(cfg, fetchImpl);
  return {
    cfg,
    db: getDb(cfg.databaseUrl),
    fetch: fetchImpl,
    llm,
    defer: p => {
      const safe = p.catch(e => console.error('tarea diferida', e instanceof Error ? e.message : e));
      try { waitUntil(safe); } catch { /* fuera de Vercel la promesa sigue corriendo igual */ }
    }
  };
}
