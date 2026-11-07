import type { Connector } from '../types.js';
import { VOICE_ENV } from '../../server/voice/tts.js';

/** Conector informativo: muestra en la interfaz si la voz está configurada. No expone herramientas al agente. */
export const voz: Connector = {
  id: 'voz',
  title: 'Voz',
  description: 'Texto a voz con Gemini TTS (o ElevenLabs si VOICE_PROVIDER=elevenlabs) y voz a texto con Gemini.',
  role: 'nucleo',
  guide: 'La síntesis se hace en el servidor, con límite de caracteres por petición.',
  requiredEnv: VOICE_ENV.gemini,
  envFor: env => (env.VOICE_PROVIDER === 'elevenlabs' ? VOICE_ENV.elevenlabs : VOICE_ENV.gemini),
  tools: () => []
};
