/**
 * Palabra clave «Oye Nyvo».
 *
 * El reconocedor del navegador no conoce la palabra «Nyvo» y la escribe de varias formas
 * (nivo, nibo, naivo…). Se aceptan esas variantes SOLO detrás de «oye».
 * Se rechazan a propósito las palabras parecidas de uso común en español: «nuevo», «nueva»,
 * «nivel», «nervio», «nido», «vivo»… y «oye» suelto, para que no se active sola en una conversación normal.
 */
const VARIANTS = ['nyvo', 'nivo', 'nibo', 'naivo', 'neivo', 'nybo', 'ni vo', 'ny vo'];
const CALL = ['oye', 'oie', 'olle'];

export function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const RE = new RegExp(`(?:^|\\s)(?:${CALL.join('|')})\\s+(?:${VARIANTS.map(v => v.replace(' ', '\\s')).join('|')})(?=\\s|$)`);

/** ¿El texto contiene la palabra clave? Devuelve además lo que se dijo después (la orden). */
export function matchWakeWord(transcript: string): { matched: boolean; command: string } {
  const t = normalize(transcript);
  const m = RE.exec(t);
  if (!m) return { matched: false, command: '' };
  return { matched: true, command: t.slice(m.index + m[0].length).trim() };
}

/** Evita activaciones repetidas: tras activarse espera `cooldownMs` antes de aceptar otra. */
export class WakeWordGate {
  private last = -Infinity;
  constructor(private cooldownMs = 5000) {}
  check(transcript: string, now = Date.now()): { matched: boolean; command: string } {
    const r = matchWakeWord(transcript);
    if (!r.matched || now - this.last < this.cooldownMs) return { matched: false, command: '' };
    this.last = now;
    return r;
  }
}
