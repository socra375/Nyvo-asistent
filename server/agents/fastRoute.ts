/**
 * Consultas claras de solo lectura («¿qué clientes tengo?», «¿hay cobros pendientes?», «lista mis archivos de Drive») que no
 * necesitan que el agente principal decida a quién delegar: van directo al especialista. Es lo que baja una consulta simple de
 * 4 llamadas al modelo a 2 (el especialista elige herramienta y redacta el resultado), con la mitad de espera y de cuota.
 *
 * Es deliberadamente conservador: ante cualquier duda (un verbo que cambia datos, una petición que pide redactar o resumir, una
 * referencia a algo dicho antes) devuelve null y todo sigue por el camino completo. El especialista recibe el mensaje tal cual,
 * así que un nombre o un filtro que diga el dueño no se pierde; lo único que no ve es la conversación anterior, y por eso las
 * referencias a ella («y los de él», «también») se descartan.
 */
import type { SpecialistId } from './specialists.js';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const READ = /\b(que|cuales|cuantos|cuantas|lista|listame|listar|muestra|muestrame|mostrar|dame|dime|ver|revisa|revisar|consulta|consultar|busca|buscar|hay|tengo|tienes)\b/;
const BUSINESS = /\b(clientes?|prospectos?|proyectos?|cobros?|pagos?|facturas?|servicios?|conversaciones)\b/;
const DRIVE = /\b(drive|archivos principales|mis archivos)\b/;
// Cualquier verbo o palabra que cambie datos, pida redactar/resumir o salga de «solo mirar».
const NOT_JUST_READING = new RegExp(`\\b(?:${[
  'crea\\w*', 'crear', 'marca\\w*', 'registra\\w*', 'agrega\\w*', 'anade\\w*', 'elimina\\w*', 'borra\\w*', 'actualiza\\w*', 'corrige\\w*',
  'responde\\w*', 'contesta\\w*', 'envia\\w*', 'manda\\w*', 'anota\\w*', 'guarda\\w*', 'recuerda\\w*', 'recuerdame', 'recordar', 'redacta\\w*',
  'escribe\\w*', 'cambia\\w*', 'programa\\w*', 'genera\\w*', 'prepara\\w*', 'haz', 'hacer', 'pon', 'poner', 'analiza\\w*', 'compara\\w*',
  'calcula\\w*', 'cobra\\w*', 'paga', 'pagar', 'factura', 'facturar', 'reporte', 'informe', 'resumen', 'resume', 'resumir', 'documenta\\w*',
  'notion', 'obsidian', 'nota', 'notas', 'borrador', 'campana', 'correo', 'email', 'mail', 'whatsapp', 'instala\\w*', 'sube', 'subir', 'descarga\\w*',
  'duplica\\w*', 'mueve', 'mover', 'comparte', 'compartir', 'recomienda\\w*', 'sugiere\\w*', 'deberia\\w*', 'conviene'
].join('|')})\\b`);
// Referencias a lo que se dijo antes: el especialista no ve la conversación, así que no se puede contestar sin ella.
const REFERS_BACK = /\b(tiene|tienen|tenia|su|sus|ese|esa|eso|esos|esas|aquel|aquella|mismo|misma|mismos|mismas|anterior|anteriores|tambien|ademas|otra vez|de nuevo|entonces|luego|despues|ahora|y los|y las|y el|y la|y ese|y esa)\b/;

export const MAX_FAST_CHARS = 140;

export interface FastRoute { specialist: SpecialistId; task: string }

/** ¿Es una consulta clara de solo lectura? → a qué especialista va y qué tarea lleva; si no, null. */
export function fastRoute(message: string): FastRoute | null {
  const raw = message.trim();
  const t = plain(raw);
  if (!t || t.length > MAX_FAST_CHARS) return null;
  if (NOT_JUST_READING.test(t) || REFERS_BACK.test(t)) return null;
  if (!READ.test(t)) return null;
  if (BUSINESS.test(t)) return { specialist: 'negocios', task: raw };
  if (DRIVE.test(t)) return { specialist: 'documentos', task: raw };
  return null;
}
