import type { Connector } from '../types.js';
import { GEMINI_ENV } from '../../server/llm/gemini.js';
import { anyEngineConfigured } from '../../server/llm/build.js';

/** Conector informativo del motor de IA: sin ninguno listo, el chat muestra «falta configurar». */
export const gemini: Connector = {
  id: 'gemini',
  title: 'Motor de IA',
  description: 'Modelo de lenguaje de Nyvo. Gemini, Groq y OpenRouter en rotación: si uno falla, pasa al siguiente (orden en LLM_PROVIDERS).',
  role: 'nucleo',
  guide: 'Motor de razonamiento del agente principal y de los especialistas.',
  requiredEnv: GEMINI_ENV,
  // Listo con que haya un motor completo (clave y modelo); si no hay ninguno, se pide el principal.
  envFor: env => (anyEngineConfigured(env) ? [] : GEMINI_ENV),
  tools: () => []
};
