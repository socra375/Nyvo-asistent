/**
 * Texto de una respuesta listo para leerlo en voz alta, o para mostrarlo sin símbolos de formato. Las voces leen el texto tal cual:
 * un «**importante**» sale como «asterisco asterisco importante». Esto quita el formato (asteriscos, guiones bajos, almohadillas,
 * comillas inversas, enlaces, emojis) y dice los símbolos como se pronuncian. Puro y sin navegador, para probarlo en Node.
 */

// Emojis y pictogramas (y sus selectores): una voz los lee como «cara sonriente» o los ignora a medias.
const PICTOGRAPHS = /\p{Extended_Pictographic}|\u{FE0E}|\u{FE0F}|\u{200D}|\u{20E3}/gu;

// Símbolos escritos que una voz lee mal (o no lee); solo español, porque lo que se dice es español.
const SPOKEN_SYMBOLS: [RegExp, string][] = [
  [/\s*°\s*C\b/g, ' grados'],
  [/\s*º\s*C\b/g, ' grados'],
  [/\s*°/g, ' grados'],
  [/\s*%/g, ' por ciento'],
  [/\bUS\$\s?/g, '$'],
  [/\bUSD\b/g, 'dólares'],
  [/\s*&\s*/g, ' y '],
  [/\s*→\s*/g, ', '],
  [/\s*[×✕]\s*/g, ' por '],
  [/[«»“”"]/g, ''],
  [/\s*[|¦]\s*/g, ', '],
  [/\s*[~^]+\s*/g, ' '],
  [/\s*(?:…|\.{3,})/g, '.']
];

/** Quita el formato Markdown de un texto, sin tocar lo demás: lo común a lo que se lee y a lo que se muestra. */
function stripMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')                                   // bloques de código: no se leen
    .replace(/`([^`\n]*)`/g, '$1')                                     // código en línea: solo su texto
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                          // imagen: su texto alternativo
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')                       // enlace: solo su texto
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')                                // títulos
    .replace(/^\s{0,3}>\s?/gm, '')                                     // citas
    .replace(/^\s*[-*•·▪◦]\s+/gm, '• ')                                // viñetas
    .replace(/(\*\*|__)(.+?)\1/g, '$2')                                // negrita
    .replace(/(^|[\s(¡¿])[*_]([^\s*_][^*_\n]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')   // cursiva
    .replace(/[*_]{2,}/g, '')                                          // restos de énfasis mal cerrado
    .replace(/(?<=\p{L})_(?=\p{L})/gu, ' ')                            // id_cliente → id cliente
    .replace(/\*/g, '');                                               // cualquier asterisco suelto
}

/** Texto para leer en voz alta: sin formato, sin enlaces ni emojis, con los símbolos dichos como se pronuncian. */
export function toSpeakable(text: string): string {
  let t = stripMarkup(text)
    .replace(/https?:\/\/\S+/gi, 'un enlace')
    .replace(/\bwww\.\S+/gi, 'un enlace')
    .replace(PICTOGRAPHS, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, m => (m === '\n' || m === '\t' ? m : ' '));
  for (const [re, to] of SPOKEN_SYMBOLS) t = t.replace(re, to);
  return t
    .replace(/^•\s*/gm, '')                                            // la viñeta no se dice: el salto de línea es la pausa
    .replace(/([^.!?:;\n])\n+(?=\S)/g, '$1. ')                         // un salto entre líneas sin puntuación es una pausa
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.,;:!?])(?:\s*[.,;:])+/g, '$1')
    .trim();
}

/** Texto para mostrar (subtítulos): sin símbolos de formato, pero con sus saltos de línea y viñetas. */
export function toCaption(text: string): string {
  return stripMarkup(text).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
