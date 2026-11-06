import type { Connector, Tool } from '../types.js';
import { addNote, relevantNotes } from '../../server/memory/memory.js';

/** Memoria interna de Nyvo (base de datos propia): no cambia datos externos, no pide tarjeta. */
const tools: Tool[] = [
  {
    name: 'recordar',
    description: 'Guarda en la memoria interna de Nyvo una preferencia o dato del usuario para usarlo en el futuro (p. ej. «prefiero que los correos sean breves»).',
    parameters: { type: 'object', properties: { nota: { type: 'string' }, etiquetas: { type: 'array', items: { type: 'string' } } }, required: ['nota'] },
    mutates: false,
    run: async (a, ctx) => {
      const n = await addNote(ctx.deps.db, ctx.userId, String(a.nota ?? ''), a.etiquetas);
      return { id: n.id, guardado: true };
    }
  },
  {
    name: 'buscar_memoria',
    description: 'Busca en la memoria interna de Nyvo notas relacionadas con un tema.',
    parameters: { type: 'object', properties: { tema: { type: 'string' } }, required: ['tema'] },
    mutates: false,
    run: async (a, ctx) => (await relevantNotes(ctx.deps.db, ctx.userId, String(a.tema ?? ''), 8)).map(n => ({ nota: n.content, etiquetas: n.tags }))
  }
];

export const memoria: Connector = {
  id: 'memoria',
  title: 'Memoria',
  description: 'Notas y preferencias del usuario guardadas por Nyvo (se pueden borrar y exportar).',
  role: 'nucleo',
  guide: 'Úsalo para recordar preferencias del usuario y consultarlas.',
  requiredEnv: ['DATABASE_URL'],
  tools: () => tools
};
