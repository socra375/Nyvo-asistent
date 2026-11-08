import type { Connector } from '../types.js';
import { anyEngineConfigured } from '../../server/llm/build.js';

/** Conector informativo del motor de IA: sin ninguno listo, el chat muestra «falta configurar». */
export const gemini: Connector = {
  id: 'gemini',
  title: 'Motor de IA',
  description: 'Modelo de lenguaje de Nyvo. Gemini, Groq, OpenRouter y Cerebras en rotación: si uno falla, pasa al siguiente (orden en LLM_PROVIDERS).',
  role: 'nucleo',
  guide: 'Motor de razonamiento del agente principal y de los especialistas.',
  requiredEnv: ['GEMINI_API_KEY'],
  // Listo con que haya la clave de un motor (el modelo gratuito por defecto se usa si no se elige otro); si no hay ninguna, se pide la principal.
  envFor: env => (anyEngineConfigured(env) ? [] : ['GEMINI_API_KEY']),
  tools: () => []
};
