/**
 * Lógica pura del «segundo cerebro» (sin red ni base de datos, para probarla sola): rutas seguras, plantillas de nota con
 * procedencia y confianza, detección de secretos y búsqueda por palabras sobre un índice en memoria.
 */

export const NYVO_DIR = 'Nyvo';
export const NOTE_TYPES = ['conocimiento', 'decision', 'cliente', 'aprendizaje', 'proyecto', 'preferencia'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export const CONFIDENCES = ['confirmado', 'probable', 'pendiente'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

const TYPE_DIR: Record<NoteType, string> = {
  conocimiento: 'conocimiento', decision: 'decisiones', cliente: 'clientes', aprendizaje: 'aprendizajes', proyecto: 'proyectos', preferencia: 'preferencias'
};

/** Quita acentos y pasa a minúsculas. Con texto en NFC conserva la longitud, así los índices de búsqueda sirven en el original. */
export const norm = (s: string): string => s.normalize('NFC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function slugify(title: string): string {
  const s = norm(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return s || 'nota';
}

/** Ruta de una nota nueva: Nyvo/<carpeta del tipo>/<título>.md (las decisiones llevan la fecha delante). */
export function notePath(type: NoteType, title: string, date: string): string {
  return `${NYVO_DIR}/${TYPE_DIR[type]}/${type === 'decision' ? `${date}-` : ''}${slugify(title)}.md`;
}

/** Valida y normaliza la ruta de una nota de la bóveda. Nunca sale de la bóveda ni toca carpetas ocultas (.obsidian, .git). */
export function safePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Falta la ruta de la nota.');
  const p = raw.trim().replace(/^\/+/, '');
  if (p.length > 200 || /[\\\p{Cc}]/u.test(p)) throw new Error('Ruta de nota inválida.');
  const parts = p.split('/');
  if (parts.some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) throw new Error('Ruta de nota inválida.');
  if (!p.toLowerCase().endsWith('.md')) throw new Error('Solo se manejan notas Markdown (.md).');
  return p;
}
export const insideNyvo = (path: string): boolean => path.startsWith(`${NYVO_DIR}/`);

// ───────────── Secretos: la skill de segundo cerebro los prohíbe; el código lo hace cumplir ─────────────
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'una clave de API de Google'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'una clave de API'],
  [/\bgsk_[A-Za-z0-9]{20,}/, 'una clave de API de Groq'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/, 'un token de GitHub'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'un token de Slack'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'una clave privada'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/, 'un token de acceso'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'un token JWT'],
  [/\bain_[A-Za-z0-9_-]{30,}/, 'una clave de AINova'],
  [/\b(?:contraseña|contrasena|password|passwd|clave|token|secreto|secret|api[ _-]?key)\b(?:\s+[\p{L}]+){0,5}\s*(?:es|:|=)\s*["']?(?=\S{6,})\S*[\d!@#$%^&*_-]\S*/iu, 'una contraseña o clave'],
  [/\bpin\b\s*(?:es|:|=)\s*\d{4,8}\b/i, 'un PIN'],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/, 'un número de cuenta (IBAN)']
];
const luhn = (digits: string): boolean => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let n = Number(digits[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
};
/** Si el texto parece contener un secreto o un dato bancario devuelve qué es (para el mensaje); si no, null. */
export function findSecret(text: string): string | null {
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) return label;
  for (const m of text.matchAll(/(?<![\d])(?:\d[ -]?){13,19}(?![\d])/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return 'un número de tarjeta';
  }
  return null;
}
export function assertNoSecret(...parts: unknown[]): void {
  const found = findSecret(parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p ?? ''))).join('\n'));
  if (found) throw new Error(`No guardo contraseñas, claves ni datos bancarios (parece haber ${found}). Quita ese dato; si hace falta, anota solo dónde está guardado (por ejemplo «en el gestor de contraseñas»).`);
}

// ───────────── Notas: frontmatter, procedencia y confianza ─────────────
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ')}"`;

export interface NoteInput {
  titulo: string; contenido: string; tipo: NoteType; confianza: Confidence; fuente: string; relacionadas: string[]; fecha: string;
}
export function buildNote(n: NoteInput): string {
  const rel = n.relacionadas.slice(0, 10).map(r => `[[${r.replace(/[[\]|#^]/g, '').trim()}]]`).filter(r => r !== '[[]]');
  return [
    '---',
    `title: ${q(n.titulo)}`,
    `type: ${n.tipo}`,
    `created: ${n.fecha}`,
    `updated: ${n.fecha}`,
    'status: active',
    `confidence: ${n.confianza}`,
    `source: ${q(n.fuente)}`,
    'author: Nyvo',
    '---',
    '',
    `# ${n.titulo}`,
    '',
    n.contenido.trim(),
    '',
    ...(rel.length ? ['## Relacionadas', rel.join(' · '), ''] : [])
  ].join('\n');
}

/** Añade una actualización con fecha al final de una nota (sin tocar lo anterior) y actualiza «updated». */
export function appendUpdate(raw: string, texto: string, confianza: Confidence, fecha: string, fuente: string): string {
  const withDate = /^---\n[\s\S]*?\n---/.test(raw) ? raw.replace(/^(---\n[\s\S]*?)\nupdated:[^\n]*/, `$1\nupdated: ${fecha}`) : raw;
  return `${withDate.trimEnd()}\n\n## Actualización ${fecha} (${confianza})\n${texto.trim()}\n\n_Fuente: ${fuente.replace(/\s+/g, ' ')}_\n`;
}

export interface Parsed { meta: Record<string, string>; body: string }
export function parseNote(raw: string): Parsed {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"');
  }
  return { meta, body: raw.slice(m[0].length) };
}

// ───────────── Búsqueda sobre el índice en memoria ─────────────
export interface Doc { path: string; sha: string; title: string; tipo?: string; confianza?: string; actualizado?: string; body: string }

export function docFrom(path: string, sha: string, raw: string): Doc {
  const { meta, body } = parseNote(raw.normalize('NFC'));
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const file = path.split('/').pop()!.replace(/\.md$/i, '');
  return { path, sha, title: (meta.title || heading || file).slice(0, 160), tipo: meta.type, confianza: meta.confidence, actualizado: meta.updated, body: body.slice(0, 60_000) };
}

const STOP = new Set('de la el los las un una unos unas y o u que en con por para del al se su sus es lo como mas pero sobre me mi tu te nos cual cuales cuando donde quien tiene tienen hay sabes dime dame cuanto cuantos'.split(' '));
export const terms = (query: string): string[] => [...new Set(norm(query).split(/[^a-z0-9ñ]+/).filter(t => t.length > 1 && !STOP.has(t)))].slice(0, 8);

export interface Hit { ruta: string; titulo: string; tipo?: string; confianza?: string; actualizado?: string; fragmento: string; puntos: number }

/** Busca por palabras (sin acentos ni mayúsculas): el título pesa más que el cuerpo y las notas con todas las palabras suben. */
export function searchDocs(docs: Iterable<Doc>, query: string, limit = 5): Hit[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const hits: Hit[] = [];
  for (const d of docs) {
    const body = norm(d.body), head = norm(`${d.title} ${d.path}`);
    let score = 0, all = true, first = -1;
    for (const t of ts) {
      let n = 0, i = body.indexOf(t);
      if (i >= 0 && (first < 0 || i < first)) first = i;
      while (i >= 0 && n < 5) { n++; i = body.indexOf(t, i + t.length); }
      const inHead = head.includes(t);
      if (!n && !inHead) all = false;
      score += n + (inHead ? 5 : 0);
    }
    if (!score) continue;
    if (all) score += 10;
    const start = Math.max(0, (first < 0 ? 0 : first) - 80);
    const raw = d.body.slice(start, start + 280).replace(/\s+/g, ' ').trim();
    hits.push({ ruta: d.path, titulo: d.title, tipo: d.tipo, confianza: d.confianza, actualizado: d.actualizado, fragmento: (start > 0 ? '…' : '') + raw, puntos: score });
  }
  return hits.sort((a, b) => b.puntos - a.puntos || String(b.actualizado ?? '').localeCompare(String(a.actualizado ?? ''))).slice(0, limit);
}

/** Texto del INDEX.md que se crea una vez en la carpeta Nyvo: mapa de la memoria y reglas, no una lista de notas. */
export function indexNote(fecha: string): string {
  return `---
title: "Índice del segundo cerebro de Nyvo"
type: index
created: ${fecha}
updated: ${fecha}
status: active
---

# Segundo cerebro de Nyvo

Notas que escribe Nyvo cuando le cuentas algo del negocio. Cada nota lleva fecha, **fuente** y **confianza** (confirmado, probable o pendiente).

## Carpetas
- \`conocimiento/\` · hechos y datos del negocio
- \`decisiones/\` · qué se decidió, alternativas y motivo (la fecha va en el nombre)
- \`clientes/\` · notas de clientes (con el identificador de AINova y los datos mínimos)
- \`aprendizajes/\` · errores y soluciones comprobadas
- \`proyectos/\` · estado y próximos pasos
- \`preferencias/\` · preferencias estables del dueño

## Reglas
- Nyvo nunca guarda contraseñas, claves, tokens ni datos bancarios.
- Si algo nuevo contradice una nota, se añade como actualización con fecha; no se borra lo anterior.
- Para revisar o corregir, edita la nota en Obsidian: Nyvo la lee de nuevo en su próxima consulta.
`;
}
