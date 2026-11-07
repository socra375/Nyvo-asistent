import type { Db } from '../db/pool.js';

export interface Note { id: string; content: string; tags: string[]; created_at: string }
export interface Style { description: string; samples: string[]; updated_at: string | null }

const cleanTags = (tags: unknown): string[] =>
  (Array.isArray(tags) ? tags : []).filter((t): t is string => typeof t === 'string').map(t => t.trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 8);

export async function addNote(db: Db, userId: string, content: string, tags: unknown = []): Promise<Note> {
  const text = content.trim().slice(0, 2000);
  if (!text) throw new Error('La nota está vacía.');
  const r = await db.query<Note>(
    'insert into memory_notes (user_id, content, tags) values ($1, $2, $3) returning id, content, tags, created_at',
    [userId, text, cleanTags(tags)]);
  return r.rows[0]!;
}

export async function listNotes(db: Db, userId: string, limit = 200): Promise<Note[]> {
  return (await db.query<Note>('select id, content, tags, created_at from memory_notes where user_id = $1 order by created_at desc limit $2', [userId, limit])).rows;
}

/** Notas relevantes para una tarea: coincidencia simple por palabras (sin enviar todo al modelo). */
export async function relevantNotes(db: Db, userId: string, task: string, limit = 5): Promise<Note[]> {
  const words = [...new Set(task.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9ñ]{4,}/g) ?? [])].slice(0, 12);
  if (!words.length) return [];
  const r = await db.query<Note & { score: number }>(
    `select id, content, tags, created_at,
       (select count(*) from unnest($2::text[]) w where translate(lower(content), 'áéíóúü', 'aeiouu') like '%' || w || '%' or w = any(tags))::int as score
     from memory_notes where user_id = $1 order by score desc, created_at desc limit $3`,
    [userId, words, limit]);
  return r.rows.filter(n => n.score > 0);
}

export async function deleteNote(db: Db, userId: string, id: string): Promise<boolean> {
  return ((await db.query('delete from memory_notes where user_id = $1 and id = $2', [userId, id])).rowCount ?? 0) > 0;
}

export async function deleteAllMemory(db: Db, userId: string): Promise<void> {
  await db.query('delete from memory_notes where user_id = $1', [userId]);
  await db.query('delete from writing_style where user_id = $1', [userId]);
}

export async function getStyle(db: Db, userId: string): Promise<Style> {
  const r = await db.query<Style>('select description, samples, updated_at from writing_style where user_id = $1', [userId]);
  return r.rows[0] ?? { description: '', samples: [], updated_at: null };
}

export async function setStyle(db: Db, userId: string, description: string, samples: unknown): Promise<Style> {
  const s = (Array.isArray(samples) ? samples : []).filter((x): x is string => typeof x === 'string').map(x => x.trim().slice(0, 3000)).filter(Boolean).slice(0, 5);
  const r = await db.query<Style>(
    `insert into writing_style (user_id, description, samples, updated_at) values ($1, $2, $3, now())
     on conflict (user_id) do update set description = excluded.description, samples = excluded.samples, updated_at = now()
     returning description, samples, updated_at`, [userId, description.trim().slice(0, 2000), s]);
  return r.rows[0]!;
}

/** Exportación completa de la memoria del usuario (JSON descargable). */
export async function exportMemory(db: Db, userId: string) {
  return { exportado: new Date().toISOString(), notas: await listNotes(db, userId, 10_000), estilo: await getStyle(db, userId) };
}
