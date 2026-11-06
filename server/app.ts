import { waitUntil } from '@vercel/functions';
import { loadConfig, type Env } from './config.js';
import { getDb } from './db/pool.js';
import { createGemini } from './llm/gemini.js';
import type { Deps } from './deps.js';

/** Construye las dependencias reales a partir de las variables de entorno. Devuelve null si falta DATABASE_URL. */
export function buildDeps(env: Env = process.env, fetchImpl: typeof fetch = fetch): Deps | null {
  const cfg = loadConfig(env);
  if (!cfg.databaseUrl) return null;
  const llm = env.GEMINI_API_KEY && env.GEMINI_MODEL
    ? createGemini({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, baseUrl: cfg.urls.gemini, fetch: fetchImpl })
    : null;
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
