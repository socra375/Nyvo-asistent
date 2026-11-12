/**
 * Los cuatro hemisferios de Nyvo (el orbe los muestra como sus cuatro secciones) y los eventos de progreso
 * que el servidor emite mientras trabaja, para que la interfaz refleje qué parte del cerebro está activa.
 */
export const HEMISPHERES = ['rose', 'johan', 'mia', 'nyvo'] as const;
export type Hemisphere = (typeof HEMISPHERES)[number];

export type TurnEvent =
  | { tipo: 'pensando' }
  | { tipo: 'hemisferio'; id: Hemisphere; estado: 'activo' | 'listo'; herramienta: string; /** Cuánto tardó la herramienta (solo en «listo»). */ ms?: number };

export type OnEvent = (e: TurnEvent) => void;

/** Herramientas de AINova que son de la recepción de mensajes de clientes (Rose). El resto de AINova es CRM (Johan). */
const ROSE_TOOLS = new Set(['list_conversations', 'read_conversation', 'reply_to_client', 'escalate_to_owner']);

/** A qué hemisferio pertenece una herramienta. Mia (agenda y formularios) se conectará en la fase 3. */
export function hemisphereFor(connectorId: string, tool: string): Hemisphere {
  if (connectorId === 'ainova') return ROSE_TOOLS.has(tool) ? 'rose' : 'johan';
  if (connectorId === 'google-calendar' || connectorId === 'google-forms') return 'mia';
  return 'nyvo';   // Notion, Drive y memoria: documentación y estrategia
}
