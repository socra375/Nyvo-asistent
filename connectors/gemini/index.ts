import type { Connector } from '../types.js';
import { GEMINI_ENV } from '../../server/llm/gemini.js';

/** Conector informativo del modelo de lenguaje: sin él, el chat muestra «falta configurar». */
export const gemini: Connector = {
  id: 'gemini',
  title: 'Gemini',
  description: 'Modelo de lenguaje de Nyvo (texto, visión y transcripción de voz).',
  role: 'nucleo',
  guide: 'Motor de razonamiento del agente principal y de los especialistas.',
  requiredEnv: GEMINI_ENV,
  tools: () => []
};
