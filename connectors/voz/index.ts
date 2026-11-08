import type { Connector } from '../types.js';
import { providerFrom, VOICE_ENV } from '../../server/voice/tts.js';
import { sttMissing } from '../../server/voice/stt.js';

/** Conector informativo: muestra en la interfaz si la voz está configurada. No expone herramientas al agente. */
export const voz: Connector = {
  id: 'voz',
  title: 'Voz',
  description: 'Texto a voz con la voz del navegador (por defecto, sin claves) o con Gemini TTS / Speechify / ElevenLabs según VOICE_PROVIDER; la voz a texto (escucha) con Whisper de Groq (GROQ_API_KEY) o, si no hay clave, con Gemini.',
  role: 'nucleo',
  guide: 'La voz sale por el navegador o por un servicio externo, con límite de caracteres por trozo.',
  requiredEnv: VOICE_ENV.gemini,
  // Salida (síntesis) + entrada (transcripción): falta configurar si no hay forma de oír o de hablar.
  envFor: env => [...VOICE_ENV[providerFrom(env)], ...sttMissing(env)],
  tools: () => []
};
