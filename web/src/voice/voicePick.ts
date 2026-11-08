/** Lo mínimo de una voz del navegador que hace falta para elegirla (permite probar sin navegador). */
export interface VoiceLike { name: string; lang: string; localService?: boolean; default?: boolean }

const norm = (l: string) => l.toLowerCase().replace('_', '-');

/**
 * Elige sola la mejor voz en español: primero las del idioma exacto del navegador (es-MX…), luego otras de América y por último
 * las de España; dentro de cada grupo prefiere las «naturales» (Natural, Neural, Online, Google) y las del sistema. Sin voces
 * en español devuelve null y el navegador usará su voz por defecto con lang «es».
 */
export function pickSpanishVoice<V extends VoiceLike>(voices: readonly V[], navLang = 'es'): V | null {
  const es = voices.filter(v => norm(v.lang).startsWith('es'));
  if (!es.length) return null;
  const mine = norm(navLang);
  const score = (v: V) => {
    const l = norm(v.lang);
    let s = 0;
    if (l === mine) s += 40;
    else if (/^es-(mx|us|419|ar|co|cl|pe|ve)/.test(l)) s += 20;
    else if (l.startsWith('es-es')) s += 10;
    if (/natural|neural|online|google|premium|enhanced/i.test(v.name)) s += 8;
    if (v.localService) s += 2;
    if (v.default) s += 1;
    return s;
  };
  return [...es].sort((a, b) => score(b) - score(a))[0] ?? null;
}
