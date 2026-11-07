import type { Connector } from '../types.js';
import { providerFrom, VOICE_ENV } from '../../server/voice/tts.js';

/** Conector informativo: muestra en la interfaz si la voz está configurada. No expone herramientas al agente. */
export const voz: Connector = {
  id: 'voz',
  title: 'Voz',
  description: 'Texto a voz con Gemini TTS, o con Speechify / ElevenLabs según VOICE_PROVIDER; la voz a texto es siempre con Gemini.',
  role: 'nucleo',
  guide: 'La síntesis se hace en el servidor, con límite de caracteres por petición.',
  requiredEnv: VOICE_ENV.gemini,
  envFor: env => VOICE_ENV[providerFrom(env.VOICE_PROVIDER)],
  tools: () => []
};
