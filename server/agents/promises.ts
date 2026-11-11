/**
 * Respuestas falsas: el modelo termina su turno con solo texto que promete algo («ahora mismo lo reviso») o lo da por hecho
 * («ya envié el correo») sin haber llamado a ninguna herramienta. El dueño ve una promesa que nadie va a cumplir, o una
 * acción que nunca ocurrió, y se queda esperando. Aquí, lo puro: reconocer esos dos casos y el aviso que se le da al modelo
 * (una sola vez por respuesta) para que lo haga de verdad o diga con sinceridad que no puede. Es el mismo criterio que usa Eddie.
 */

// Verbos de hacer cosas, sin tildes (el texto se normaliza): primera persona del presente, infinitivo y gerundio.
const PRESENT = 'completo|relleno|lleno|agrego|anado|arreglo|corrijo|creo|hago|escribo|edito|pongo|actualizo|reviso|busco|abro|preparo|armo|genero|mando|envio|guardo|borro|elimino|cambio|modifico|termino|redacto|organizo|programo|agendo|anoto|pido|consulto|calculo|investigo|miro|verifico|compruebo|localizo|listo|traigo|saco';
const INFINITIVE = 'completar|rellenar|llenar|agregar|anadir|arreglar|corregir|crear|hacer|escribir|editar|poner|actualizar|revisar|buscar|abrir|preparar|armar|generar|mandar|enviar|guardar|borrar|eliminar|cambiar|modificar|terminar|redactar|organizar|programar|agendar|anotar|pedir|consultar|calcular|investigar|mirar|verificar|comprobar|localizar|traer|sacar|consultarlo';
const GERUND = 'completando|rellenando|llenando|agregando|anadiendo|arreglando|corrigiendo|creando|haciendo|escribiendo|editando|actualizando|revisando|buscando|preparando|trabajando|generando|armando|guardando|procesando|redactando|organizando|consultando|mirando|verificando|comprobando|localizando|cargando';
const IMMEDIATE = 'ahora mismo|ya mismo|enseguida|en seguida|de inmediato|al instante|ahorita|inmediatamente|en un momento|un momento|un segundo|unos segundos';
// Participios de acciones que cambian cosas: «ya lo envié», «he creado», «quedó guardado».
const DONE_PAST = 'envie|cree|registre|guarde|actualice|elimine|borre|agende|anote|marque|respondi|escribi|publique|cambie|corregi|genere|prepare|mande|programe|redacte|agregue|anadi|modifique|complete|termine|archive|cancele|aprobe';
const DONE_PART = 'enviado|creado|registrado|guardado|actualizado|eliminado|borrado|agendado|anotado|marcado|respondido|escrito|publicado|cambiado|corregido|generado|preparado|mandado|programado|redactado|agregado|anadido|modificado|completado|terminado|archivado|cancelado|aprobado';

const plain = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const PROMISES = [
  new RegExp(`\\bvoy a (?:${INFINITIVE})\\b`),
  new RegExp(`\\bestoy (?:${GERUND})\\b`),
  /\bprocedo a \w+|\bme pongo (?:a|con) \w+/,
  new RegExp(`\\b(?:${IMMEDIATE})\\b[^.!]*\\b(?:${PRESENT})\\b`),
  new RegExp(`\\b(?:${PRESENT})\\b[^.!]*\\b(?:${IMMEDIATE})\\b`),
  /\bdame (?:un |unos )?(?:momento|segundo|minuto)s?\b/,
  /\bdejame (?:\w+ ){0,2}(?:revisar|mirar|buscar|consultar|ver|verificar|comprobar)\b/
];

const CLAIMS = [
  new RegExp(`\\bya (?:lo |la |los |las |se lo |te lo )?(?:${DONE_PAST})\\b`),
  new RegExp(`\\b(?:he|hemos) (?:${DONE_PART})\\b`),
  new RegExp(`\\bquedo (?:ya )?(?:${DONE_PART})\\b`),
  new RegExp(`\\b(?:listo|hecho)[,.!:]?\\s+(?:ya )?(?:lo |la |los |las )?(?:${DONE_PAST}|${DONE_PART})\\b`)
];

const short = (t: string) => t.length > 0 && t.length <= 700 && !/[?¿]/.test(t);

/** ¿Termina el turno prometiendo hacer algo ya? Una pregunta («¿quieres que lo revise ahora mismo?») no es una promesa, ni una respuesta larga. */
export function isEmptyPromise(text: string): boolean {
  const t = plain(text).replace(/\s+/g, ' ').trim();
  return short(t) && PROMISES.some(r => r.test(t));
}

/**
 * ¿Da por hecha una acción («ya lo creé», «quedó guardado»)? Solo cuenta en una respuesta corta y sin pregunta, y una frase con
 * negación («todavía no lo he enviado», «no pude crearlo») es justo la respuesta sincera, no una afirmación falsa.
 */
export function claimsDone(text: string): boolean {
  const t = plain(text).replace(/\s+/g, ' ').trim();
  if (!short(t)) return false;
  return t.split(/[.!;:]+/).some(sentence => !/\b(?:no|nunca|tampoco|ni)\b/.test(sentence) && CLAIMS.some(r => r.test(sentence)));
}

/** Lo que se le dice al agente principal (es un mensaje del sistema, no del dueño). */
export const PROMISE_NUDGE_MAIN =
  '[Aviso del sistema, no del dueño] En tu mensaje anterior dijiste que ibas a hacer algo ahora mismo, pero no llamaste a «delegar», así que no hiciste nada. Hazlo ya: llama a «delegar» con el especialista y la tarea que corresponden. Si no hay forma de hacerlo, dilo con sinceridad en una frase y ofrece lo que sí puedes hacer. No prometas algo que no vas a ejecutar en esta misma respuesta.';

/** Lo mismo para un especialista: debe usar una herramienta suya. */
export const PROMISE_NUDGE_SPECIALIST =
  '[Aviso del sistema] En tu mensaje anterior dijiste que ibas a hacer algo ahora mismo, pero no llamaste a ninguna herramienta, así que no hiciste nada. Hazlo ya con la herramienta que corresponde (si necesitas leer algo antes, léelo con su herramienta). Si no tienes ninguna herramienta para eso, dilo con sinceridad y explica qué falta. No prometas algo que no vas a ejecutar en esta misma respuesta.';

/** Para dar por hecho algo sin haberlo hecho. */
export const CLAIM_NUDGE =
  '[Aviso del sistema] Dijiste que ya hiciste algo, pero en esta respuesta no llamaste a ninguna herramienta ni recibiste ningún resultado que lo confirme. No des nada por hecho: hazlo ahora con la herramienta que corresponde, o di con sinceridad que todavía no se ha hecho. Recuerda que los cambios quedan en una tarjeta que el dueño confirma: nunca digas que ya están hechos mientras estén pendientes.';
