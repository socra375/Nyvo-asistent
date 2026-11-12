import { toSpeakable } from './speechText.js';

/**
 * Parte una respuesta en trozos para leerla por partes: el primero es corto (la voz empieza antes) y el resto
 * se sintetiza mientras suena el anterior. Corta en puntuación, no a mitad de frase.
 */
export function chunkForSpeech(text: string, opts: { firstMax?: number; max?: number } = {}): string[] {
  const firstMax = opts.firstMax ?? 120;
  const max = opts.max ?? 260;
  const clean = toSpeakable(text).replace(/\s+/g, ' ').trim();   // sin asteriscos ni formato: la voz los leería
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…;:\n]+[.!?…;:]*\s*/g)?.map(s => s.trim()).filter(Boolean) ?? [clean];
  const out: string[] = [];
  let cur = '';
  for (let s of sentences) {
    const limit = out.length === 0 ? firstMax : max;
    // Frases enormes sin puntuación: se parten por comas o, en último caso, por palabras.
    while (s.length > limit) {
      const cut = Math.max(s.lastIndexOf(',', limit), s.lastIndexOf(' ', limit));
      const at = cut > limit * 0.4 ? cut : limit;
      if (cur) { out.push(cur); cur = ''; }
      out.push(s.slice(0, at + (s[at] === ',' ? 1 : 0)).trim());
      s = s.slice(at + (s[at] === ',' ? 1 : 0)).trim();
    }
    if (!s) continue;
    const lim = out.length === 0 ? firstMax : max;
    if (cur && (cur + ' ' + s).length > lim) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  // Un trozo de solo signos («…», «¿?») no se puede leer y algunos proveedores lo rechazan: se descarta.
  return out.filter(c => /[\p{L}\p{N}]/u.test(c));
}
