import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import type { Llm } from './llm/types.js';

/** Dependencias inyectables: en producción son reales; en pruebas se sustituyen por falsas. */
export interface Deps {
  cfg: Config;
  db: Db;
  fetch: typeof fetch;
  /** Modelo de lenguaje, o null si falta configurar Gemini. */
  llm: Llm | null;
  /** Continúa trabajo tras responder (waitUntil en Vercel). */
  defer: (p: Promise<unknown>) => void;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
}
