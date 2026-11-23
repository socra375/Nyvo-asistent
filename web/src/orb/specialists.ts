import type { Hemi, SectionMode } from './orbModel.js';

/** Mismos valores que ConnectorState (lib/api.ts); se repiten aquí para que este módulo no dependa de nada y se pruebe sin navegador. */
type ConnectorState = 'listo' | 'falta_configurar' | 'falta_conectar' | 'desactivado';

/** Qué hace de verdad cada especialista hoy (solo lo que existe en el código) y de qué conectores depende. */
export interface SpecialistInfo {
  description: string;
  capabilities: { text: string; connector?: string }[];
  /** Aviso fijo cuando algo no existe todavía (se dice tal cual). */
  note?: string;
  /** Conectores cuyo «falta configurar» deja al especialista como «No configurado». */
  connectors: string[];
  /** «todos»: hace falta que falten todos; «alguno»: basta con uno. */
  needs: 'todos' | 'alguno';
}

export const SPECIALISTS: Record<Hemi, SpecialistInfo> = {
  rose: {
    description: 'Atiende los mensajes y las conversaciones con clientes del panel de AINova.',
    capabilities: [{ text: 'Leer los mensajes y conversaciones de AINova', connector: 'ainova' }],
    connectors: ['ainova'], needs: 'alguno'
  },
  johan: {
    description: 'Lleva los clientes, proyectos y cobros de AINova.',
    capabilities: [
      { text: 'Consultar clientes y proyectos', connector: 'ainova' },
      { text: 'Consultar cobros y facturas', connector: 'ainova' }
    ],
    connectors: ['ainova'], needs: 'alguno'
  },
  mia: {
    description: 'Está pensada para la agenda: citas y formularios de entrada.',
    capabilities: [],
    note: 'La agenda hoy NO está conectada: Mia todavía no puede leer ni crear eventos.',
    connectors: [], needs: 'alguno'
  },
  nyvo: {
    description: 'Estrategia y archivo: reúne tus notas y documentos para decidir.',
    capabilities: [
      { text: 'Guardar y buscar notas y reportes en Notion', connector: 'notion' },
      { text: 'Buscar y abrir archivos de Google Drive', connector: 'google-drive' }
    ],
    note: 'El segundo cerebro (Obsidian) está retirado; la memoria vive en Nyvo.',
    connectors: ['notion', 'google-drive'], needs: 'todos'
  }
};

export type ConnectorMap = Record<string, ConnectorState>;

/** Estado visible de un especialista: el de su sección en el orbe, salvo «No configurado» cuando falta configurar su conector. */
export function specialistStatus(h: Hemi, mode: SectionMode, conns: ConnectorMap | null): 'Trabajando' | 'Listo' | 'Disponible' | 'No configurado' {
  const info = SPECIALISTS[h];
  if (conns && info.connectors.length) {
    const missing = info.connectors.map(c => conns[c] === 'falta_configurar');
    if (info.needs === 'todos' ? missing.every(Boolean) : missing.some(Boolean)) return 'No configurado';
  }
  return mode === 'activo' ? 'Trabajando' : mode === 'listo' ? 'Listo' : 'Disponible';
}
