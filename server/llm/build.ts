import type { Config } from '../config.js';
import { createGemini } from './gemini.js';
import { createOpenAiCompat } from './openai-compat.js';
import { createFailover, type Engine } from './failover.js';
import type { Llm } from './types.js';

type Env = Record<string, string | undefined>;

interface EngineDef { name: string; keyVar: string; modelVar: string; /** Modelo gratuito por defecto si solo hay clave. */ defaultModel: string }
/** Motores conocidos, por orden de preferencia por defecto. */
export const ENGINES: readonly EngineDef[] = [
  { name: 'gemini', keyVar: 'GEMINI_API_KEY', modelVar: 'GEMINI_MODEL', defaultModel: 'gemini-flash-lite-latest' },
  { name: 'groq', keyVar: 'GROQ_API_KEY', modelVar: 'GROQ_MODEL', defaultModel: 'openai/gpt-oss-120b' },
  { name: 'openrouter', keyVar: 'OPENROUTER_API_KEY', modelVar: 'OPENROUTER_MODEL', defaultModel: 'openrouter/free' },
  { name: 'cerebras', keyVar: 'CEREBRAS_API_KEY', modelVar: 'CEREBRAS_MODEL', defaultModel: 'llama-3.3-70b' }
];

/** Orden pedido en LLM_PROVIDERS (coma); los nombres desconocidos o repetidos se ignoran. Por defecto, todos. */
export function engineOrder(env: Env): EngineDef[] {
  const asked = (env.LLM_PROVIDERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const names = asked.length ? asked : ENGINES.map(e => e.name);
  return [...new Set(names)].flatMap(n => ENGINES.filter(e => e.name === n));
}
/** Modelos de un motor: la variable admite uno o varios separados por coma (se prueban en ese orden), sin repetidos. Si no hay ninguno, el modelo gratuito por defecto. */
export function modelsOf(env: Env, d: EngineDef): string[] {
  const asked = [...new Set((env[d.modelVar] ?? '').split(',').map(s => s.trim()).filter(Boolean))];
  return asked.length ? asked : [d.defaultModel];
}
export const engineConfigured = (env: Env, d: EngineDef) => Boolean(env[d.keyVar]?.trim());
/** ¿Hay al menos un motor listo? */
export const anyEngineConfigured = (env: Env) => engineOrder(env).some(d => engineConfigured(env, d));

/** Si Groq retira el modelo configurado: este orden de preferencia entre los que siga ofreciendo (los mismos que usa Eddie). */
const GROQ_PREFERENCES: (string | RegExp)[] = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', /^qwen\//, /^meta-llama\/llama-4/, /^moonshotai\//];

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

const explicitThinking = (env: Env): number | undefined => {
  const v = env.GEMINI_THINKING_BUDGET;
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
};

/** «Pensar» oculto de Gemini: también gasta cuota. Si GEMINI_THINKING_BUDGET no está puesto, se apaga en los modelos Flash (los demás, p. ej. Pro, no admiten apagarlo). */
export function thinkingBudgetFor(env: Env, model: string): number | undefined {
  return explicitThinking(env) ?? (/flash/i.test(model) ? 0 : undefined);
}

/** Sin GEMINI_THINKING_BUDGET, los Flash bajan solos por la escalera de «pensar» (0 → «minimal» → «low» → sin ajuste) según lo que admita cada versión del modelo. */
export const thinkingIsAuto = (env: Env, model: string): boolean => explicitThinking(env) === undefined && /flash/i.test(model);

/** Arma el motor de IA (con rotación si hay varios configurados), o null si no hay ninguno. */
export function buildLlm(cfg: Config, fetchImpl: typeof fetch): Llm | null {
  const env = cfg.env;
  const engines: Engine[] = [];
  for (const d of engineOrder(env)) {
    if (!engineConfigured(env, d)) continue;
    const apiKey = env[d.keyVar]!.trim();
    const models = modelsOf(env, d);
    for (const model of models) {
      // Con varios modelos del mismo proveedor, cada uno es un motor aparte (cuota y enfriamiento propios): «groq:modelo».
      const name = models.length > 1 ? `${d.name}:${model}` : d.name;
      if (d.name === 'gemini') engines.push({ name, model, transcribes: true, llm: createGemini({ apiKey, model, baseUrl: cfg.urls.gemini, fetch: fetchImpl, thinkingBudget: explicitThinking(env), thinkingAuto: thinkingIsAuto(env, model) }) });
      else if (d.name === 'groq') engines.push({ name, model, llm: createOpenAiCompat({ name: 'Groq', apiKey, model, baseUrl: `${cfg.urls.groq}/v1`, fetch: fetchImpl, reasoningEffort: /gpt-oss/i.test(model) ? 'low' : undefined, maxInputTokens: num(env.GROQ_MAX_INPUT_TOKENS, 7_500) || undefined, modelPreferences: GROQ_PREFERENCES }) });
      else if (d.name === 'cerebras') engines.push({ name, model, llm: createOpenAiCompat({ name: 'Cerebras', apiKey, model, baseUrl: `${cfg.urls.cerebras}/v1`, fetch: fetchImpl }) });
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
