/**
 * Una sola voz: Nyvo habla como una persona, no como un comité. El modelo a veces nombra a sus «hemisferios»
 * (Rose, Johan, Mia) o presenta el dato («Johan me informa que…»). El prompt lo prohíbe; este filtro quita lo más
 * evidente por si aun así se cuela, antes de mostrarlo o leerlo en voz alta. No intenta reescribir prosa libre.
 */
const NAMES = 'Rose|Johan|Mia';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function cleanReply(text: string): string {
  let t = text
    // Restos de una llamada a herramienta escrita como texto: nunca se muestran ni se leen en voz alta
    .replace(/<function_calls>[\s\S]*?(?:<\/function_calls>|$)/gi, '')
    .replace(/<\/?(?:function_calls|invoke|parameter)\b[^>]*>/gi, '')
    // Etiquetas del documento del cerebro: «[ROSE]:», «[MIA -> JOHAN]:», «[NYVO]»
    .replace(/\[(?:ROSE|JOHAN|MIA|NYVO)(?:\s*(?:->|→|,|y)\s*(?:ROSE|JOHAN|MIA|NYVO))*\]\s*:?\s*/g, '')
    // Rótulo al empezar una línea: «Johan: tienes…», «Rose – …»
    .replace(new RegExp(`^(?:${NAMES})\\s*(?:\\([^)]*\\))?\\s*[:–—-]\\s+`, 'gm'), '')
    // «Según Johan, …» / «De acuerdo con Rose, …»
    .replace(new RegExp(`\\b(?:[Ss]egún|[Dd]e acuerdo con|[Pp]or parte de)\\s+(?:${NAMES})\\s*,?\\s+`, 'g'), '')
    // «Johan me informa que …», «Rose me avisa de que …»
    .replace(new RegExp(`\\b(?:${NAMES})\\s+me\\s+(?:informa|dice|indica|comenta|avisa|cuenta|confirma|reporta)\\s+(?:de\\s+)?que\\s+`, 'g'), '');
  // La interfaz no interpreta Markdown (se vería «**así**») y la voz lo leería: se quita el formato y se dejan las viñetas como «•».
  t = t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^(\s*)[*•]\s+/gm, '$1• ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(¡¿])\*([^\s*][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\*{2,}/g, '');
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  // Tras quitar un prefijo, la frase puede quedar en minúscula
  t = t.replace(/(^|[.!?¡¿]\s+|\n)([a-záéíóúñ])/g, (_m, pre: string, c: string) => pre + cap(c));
  return t;
}
