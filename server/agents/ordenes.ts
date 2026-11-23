/**
 * Órdenes vagas y cortesía vacía. El dueño dice «trabaja» y el modelo, sin herramientas, contesta «De nada, ¿en qué más puedo
 * ayudarte?»: ni hace ni pregunta nada. Aquí, lo puro: reconocer una respuesta que es solo cortesía de cierre, un mensaje del
 * dueño que de verdad es social (gracias, hola…, donde la cortesía sí corresponde) y una orden breve sin tema. Los usa main.ts.
 */

const plain = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Sin signos ni emojis: quedan letras, dígitos y espacios. */
const words = (s: string) => plain(s).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean);

// Frases de cortesía de cierre (sin tildes). Si, al quitarlas, no queda nada, el texto no tenía contenido.
const COURTESY = [
  /\bno hay de que\b/g, /\bde nada\b/g, /\bcon (?:mucho )?gusto\b/g, /\ba tu servicio\b/g, /\bpara eso estoy\b/g, /\bun placer\b/g, /\bencantado\b/g,
  /\ben que (?:mas )?(?:te |le )?(?:puedo|podria) ayudar(?:te|le)?(?: hoy| ahora)?\b/g, /\ben que mas\b/g,
  /\b(?:hay )?algo (?:mas )?(?:en lo )?que (?:te )?(?:pueda|puedo) ayudar(?:te)?\b/g,
  /\b(?:necesitas|quieres|deseas|requieres) algo mas\b/g, /\balgo mas(?: en lo que (?:te )?(?:pueda|puedo) ayudar(?:te)?)?\b/g,
  /\bcualquier (?:otra )?cosa (?:me avisas|avisame|dime|dimelo)\b/g, /\bno dudes en (?:pedirmelo|pedirme|decirmelo)\b/g,
  /\bestoy aqui\b/g, /\baqui estoy\b/g, /\bclaro\b/g, /\bpor supuesto\b/g, /\bhola\b/g, /\bdime\b/g, /\by\b/g, /\bsi\b/g
];
const MAX_COURTESY_CHARS = 160;

/** ¿La respuesta es solo cortesía de cierre, sin contenido («De nada, ¿en qué más puedo ayudarte?»)? Un texto largo, o con algo más, no. */
export function isCourtesyOnly(text: string): boolean {
  const t = plain(text).replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_COURTESY_CHARS) return false;
  let rest = t;
  for (const r of COURTESY) rest = rest.replace(r, ' ');
  const left = rest.replace(/[^a-z0-9ñ]/g, '');
  return left.length === 0 && t !== rest.trim() && /\b(?:de nada|gusto|servicio|ayudar|algo mas|en que mas|no hay de que|para eso estoy|placer|encantado|cosa)\b/.test(t);
}

const SOCIAL_CORE = new Set(['gracias', 'hola', 'buenas', 'buenos', 'adios', 'chao', 'chau', 'ok', 'okay', 'vale', 'perfecto', 'genial', 'excelente', 'entendido', 'listo', 'hasta', 'bien', 'saludos', 'muchas', 'acuerdo']);
const SOCIAL_FILL = new Set(['de', 'dias', 'tardes', 'noches', 'mil', 'luego', 'pronto', 'manana', 'muy', 'buen', 'trabajo', 'nyvo', 'y', 'tambien', 'mucho', 'todo', 'ya', 'eso', 'es', 'todo', 'por', 'ahora']);

/** ¿El mensaje del dueño es social (gracias, saludo, despedida, «ok»)? Ahí «de nada» es una respuesta legítima. */
export function isSocial(message: string): boolean {
  const w = words(message);
  if (!w.length || w.length > 6) return false;
  return w.every(x => SOCIAL_CORE.has(x) || SOCIAL_FILL.has(x)) && w.some(x => SOCIAL_CORE.has(x));
}

const ORDER_CORE = new Set(['trabaja', 'trabajalo', 'trabajalas', 'hazlo', 'hazla', 'hazlos', 'haz', 'continua', 'continualo', 'sigue', 'seguir', 'sigamos', 'continuemos', 'adelante', 'procede', 'dale', 'empieza', 'empezar', 'comienza', 'comenzar', 'arranca']);
const ORDER_FILL = new Set(['ya', 'ahora', 'nyvo', 'por', 'favor', 'con', 'eso', 'ello', 'asi', 'mismo', 'pues', 'entonces', 'porfa']);

/** ¿Es una orden breve sin tema («trabaja», «hazlo», «sigue», «dale»)? Tres palabras o menos y sin nada que diga sobre qué. */
export function isVagueOrder(message: string): boolean {
  const w = words(message);
  if (!w.length || w.length > 3) return false;
  return w.every(x => ORDER_CORE.has(x) || ORDER_FILL.has(x)) && w.some(x => ORDER_CORE.has(x));
}

/** Nota que se añade al turno que ve el modelo (no al mensaje guardado ni al que ve el dueño). */
export const VAGUE_ORDER_HINT = '\n\n[Orden breve sin detalle: continúa la última tarea pendiente del historial o pregunta una cosa concreta; no respondas con cortesía.]';

/** Aviso al modelo (es del sistema, no del dueño): una sola vez por turno. */
export const COURTESY_NUDGE =
  '[Aviso del sistema, no del dueño] El dueño hizo una pregunta o pidió trabajo; no dio las gracias. Consulta los datos con «delegar» o, si falta un dato, pregúntale UNA cosa concreta con ejemplos de «Mis negocios». No respondas con cortesía («de nada», «¿en qué más puedo ayudarte?»).';

/** Si tras el aviso el modelo vuelve a contestar solo cortesía, esto sustituye su respuesta. */
export const COURTESY_FALLBACK = '¿Qué quieres que haga ahora? Por ejemplo: revisar tus cobros pendientes, listar tus clientes o ver tus archivos de Drive.';
