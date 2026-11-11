import type { Deps } from '../server/deps.js';
import type { Schema } from '../server/llm/types.js';

/** Especialista que usa las herramientas del conector. */
export type Role = 'negocios' | 'documentos' | 'navegador' | 'habilidades' | 'nucleo';

export interface ToolContext {
  deps: Deps;
  userId: string;
  /** Ajustes del usuario para este conector (connector_settings.settings). */
  settings: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Tool {
  /** Nombre corto, único dentro del conector. */
  name: string;
  description: string;
  parameters: Schema;
  /** true si cambia datos externos: entonces pide confirmación en una tarjeta. */
  mutates: boolean;
  /**
   * Excepción aprobada por el usuario: algunas escrituras de bajo riesgo se hacen solas
   * y muestran después una tarjeta «Deshacer». Solo si la función devuelve true.
   */
  autoApprove?: (ctx: ToolContext, args: Record<string, unknown>) => boolean;
  /**
   * Comprobación previa de los argumentos: si lanza un error se le devuelve al modelo en el acto, sin crear tarjeta ni ejecutar nada
   * (por ejemplo, rechazar un secreto antes de que el dueño tenga que confirmar nada).
   */
  validate?: (args: Record<string, unknown>) => void;
  /** Resumen legible para la tarjeta de confirmación. */
  summarize?: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  /** Datos para deshacer a partir del resultado (si la herramienta se puede deshacer). */
  undoInfo?: (result: unknown) => Record<string, unknown> | null;
}

export interface PanelItem {
  id: string;
  title: string;
  subtitle?: string;
  url?: string;
  badge?: string;
}

export interface Connector {
  id: string;
  title: string;
  description: string;
  role: Role;
  /** Cuándo usarlo (se incluye en las instrucciones del especialista). */
  guide: string;
  /** Variables de entorno necesarias. Si falta alguna, la interfaz muestra «falta configurar». */
  requiredEnv: readonly string[];
  /** Si las variables dependen de otra (p. ej. el proveedor de voz), las calcula aquí. */
  envFor?: (env: Record<string, string | undefined>) => readonly string[];
  /** Permisos de Google que pide este conector (se piden por partes, al conectarlo). */
  google?: { scopes: string[] };
  /** Ajustes por defecto editables por el usuario. */
  defaultSettings?: Record<string, unknown>;
  tools: (ctx: ToolContext) => Promise<Tool[]> | Tool[];
  undo?: (info: Record<string, unknown>, ctx: ToolContext) => Promise<void>;
}

export type ConnectorState = 'listo' | 'falta_configurar' | 'falta_conectar' | 'desactivado';

export interface ConnectorStatus {
  id: string;
  title: string;
  description: string;
  role: Role;
  guide: string;
  requiredEnv: readonly string[];
  state: ConnectorState;
  missingEnv: string[];
  missingScopes: string[];
  settings: Record<string, unknown>;
}
