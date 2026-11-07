/**
 * Máquina de estados de la conversación por voz (manos libres). No sabe de micrófono ni de red: recibe eventos
 * (voz detectada, respuesta lista…) y decide qué hacer. Así se prueba entera, incluida la interrupción.
 *
 *   inactivo ──tocar──▶ escuchando ──frase──▶ pensando ──respuesta──▶ hablando ──fin──▶ escuchando
 *                           ▲                    │                        │
 *                           └──── interrupción (el usuario habla) ◀────────┘
 */
export type ConvState = 'inactivo' | 'escuchando' | 'pensando' | 'hablando';

export type ConvEvent =
  | { tipo: 'activar' }
  | { tipo: 'desactivar' }
  | { tipo: 'voz-inicia'; interrumpe: boolean }
  | { tipo: 'frase-lista' }          // el VAD cerró una frase y ya se envía a transcribir
  | { tipo: 'sin-texto' }            // la transcripción vino vacía
  | { tipo: 'respuesta-lista'; hayVoz: boolean }
  | { tipo: 'voz-termina' }          // terminó de leer la respuesta
  | { tipo: 'error' };

export type ConvAction = 'cortar-voz' | 'cancelar-peticion' | 'abrir-microfono' | 'cerrar-microfono' | 'empezar-frase';

export interface ConvStep { state: ConvState; actions: ConvAction[] }

export function stepConversation(state: ConvState, e: ConvEvent): ConvStep {
  switch (e.tipo) {
    case 'activar':
      return state === 'inactivo' ? { state: 'escuchando', actions: ['abrir-microfono'] } : { state, actions: [] };
    case 'desactivar':
      return { state: 'inactivo', actions: ['cortar-voz', 'cancelar-peticion', 'cerrar-microfono'] };
    case 'voz-inicia':
      if (state === 'hablando') return { state: 'escuchando', actions: ['cortar-voz', 'empezar-frase'] };       // interrupción
      if (state === 'pensando') return { state: 'escuchando', actions: ['cancelar-peticion', 'empezar-frase'] }; // cambia de idea
      if (state === 'escuchando') return { state, actions: ['empezar-frase'] };
      return { state, actions: [] };
    case 'frase-lista':
      return state === 'escuchando' ? { state: 'pensando', actions: [] } : { state, actions: [] };
    case 'sin-texto':
      return state === 'pensando' ? { state: 'escuchando', actions: [] } : { state, actions: [] };
    case 'respuesta-lista':
      if (state !== 'pensando') return { state, actions: [] };   // llegó tarde: el usuario ya habló otra vez
      return e.hayVoz ? { state: 'hablando', actions: [] } : { state: 'escuchando', actions: [] };
    case 'voz-termina':
      return state === 'hablando' ? { state: 'escuchando', actions: [] } : { state, actions: [] };
    case 'error':
      return state === 'inactivo' ? { state, actions: [] } : { state: 'escuchando', actions: ['cortar-voz'] };
  }
}
