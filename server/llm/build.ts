import type { Config } from '../config.js';
import { createGemini } from './gemini.js';
import { createOpenAiCompat } from './openai-compat.js';
import { createFailover, type Engine } from './failover.js';
import type { Llm } from './types.js';

type Env = Record<string, string | undefined>;

interface EngineDef { name: string; keyVar: string; modelVar: string }
/** Motores conocidos, por orden de preferencia por defecto. */
export const ENGINES: readonly EngineDef[] = [
  { name: 'gemini', keyVar: 'GEMINI_API_KEY', modelVar: 'GEMINI_MODEL' },
  { name: 'groq', keyVar: 'GROQ_API_KEY', modelVar: 'GROQ_MODEL' },
  { name: 'openrouter', keyVar: 'OPENROUTER_API_KEY', modelVar: 'OPENROUTER_MODEL' }
];

/** Orden pedido en LLM_PROVIDERS (coma); los nombres desconocidos o repetidos se ignoran. Por defecto, todos. */
export function engineOrder(env: Env): EngineDef[] {
  const asked = (env.LLM_PROVIDERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const names = asked.length ? asked : ENGINES.map(e => e.name);
  return [...new Set(names)].flatMap(n => ENGINES.filter(e => e.name === n));
}
/** Modelos pedidos para un motor: la variable admite uno o varios separados por coma (se prueban en ese orden). Sin repetidos. */
export function modelsOf(env: Env, d: EngineDef): string[] {
  return [...new Set((env[d.modelVar] ?? '').split(',').map(s => s.trim()).filter(Boolean))];
}
export const engineConfigured = (env: Env, d: EngineDef) => Boolean(env[d.keyVar] && modelsOf(env, d).length);
/** ¿Hay al menos un motor listo? */
export const anyEngineConfigured = (env: Env) => engineOrder(env).some(d => engineConfigured(env, d));

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

/** Arma el motor de IA (con rotación si hay varios configurados), o null si no hay ninguno. */
export function buildLlm(cfg: Config, fetchImpl: typeof fetch): Llm | null {
  const env = cfg.env;
  const engines: Engine[] = [];
  for (const d of engineOrder(env)) {
    if (!engineConfigured(env, d)) continue;
    const apiKey = env[d.keyVar]!;
    const models = modelsOf(env, d);
    for (const model of models) {
      // Con varios modelos del mismo proveedor, cada uno es un motor aparte (cuota y enfriamiento propios): «groq:modelo».
      const name = models.length > 1 ? `${d.name}:${model}` : d.name;
      if (d.name === 'gemini') engines.push({ name, model, transcribes: true, llm: createGemini({ apiKey, model, baseUrl: cfg.urls.gemini, fetch: fetchImpl, thinkingBudget: env.GEMINI_THINKING_BUDGET !== undefined && env.GEMINI_THINKING_BUDGET !== '' && Number.isFinite(Number(env.GEMINI_THINKING_BUDGET)) ? Number(env.GEMINI_THINKING_BUDGET) : undefined }) });
      else if (d.name === 'groq') engines.push({ name, model, llm: createOpenAiCompat({ name: 'Groq', apiKey, model, baseUrl: `${cfg.urls.groq}/v1`, fetch: fetchImpl }) });
      else engines.push({ name, model, llm: createOpenAiCompat({ name: 'OpenRouter', apiKey, model, baseUrl: `${cfg.urls.openrouter}/v1`, fetch: fetchImpl }) });
    }
  }
  if (!engines.length) return null;
  return createFailover(engines, {
    attemptTimeoutMs: num(env.LLM_ATTEMPT_TIMEOUT_MS, 10_000),
    cooldownMs: num(env.LLM_COOLDOWN_MS, 60_000),
    onSwitch: e => console.warn(`motor de IA: ${e.from} falló (${e.error})${e.to ? `; paso a ${e.to}` : '; no quedan más'}`)
  });
}
