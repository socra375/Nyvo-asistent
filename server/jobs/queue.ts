import type { Db } from '../db/pool.js';

export interface Job {
  id: string;
  user_id: string | null;
  conversation_id: string | null;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  run_after: string;
  result: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = 'id, user_id, conversation_id, kind, title, payload, status, attempts, max_attempts, run_after, result, error, created_at, updated_at';
/** Si una ejecución se corta (Vercel la mata a los 60 s), el trabajo se libera tras este tiempo y se reintenta. */
export const LOCK_SECONDS = 90;

export async function enqueue(db: Db, j: { userId: string | null; conversationId?: string | null; kind: string; title: string; payload: Record<string, unknown>; maxAttempts?: number }): Promise<Job> {
  const r = await db.query<Job>(
    `insert into jobs (user_id, conversation_id, kind, title, payload, max_attempts) values ($1, $2, $3, $4, $5, $6) returning ${COLS}`,
    [j.userId, j.conversationId ?? null, j.kind, j.title.slice(0, 200), j.payload, j.maxAttempts ?? 3]);
  return r.rows[0]!;
}

/**
 * Reclama el siguiente trabajo listo. FOR UPDATE SKIP LOCKED evita que dos instancias tomen el mismo.
 * También recupera trabajos «running» cuyo bloqueo venció (la instancia murió a mitad).
 */
export async function claim(db: Db): Promise<Job | null> {
  const r = await db.query<Job>(
    `update jobs set status = 'running', attempts = attempts + 1, locked_until = now() + make_interval(secs => $1), updated_at = now()
     where id = (
       select id from jobs
       where (status = 'queued' and run_after <= now())
          or (status = 'running' and locked_until < now())
       order by run_after, created_at
       for update skip locked limit 1)
     returning ${COLS}`, [LOCK_SECONDS]);
  const job = r.rows[0];
  if (!job) return null;
  // Un trabajo recuperado que ya agotó sus intentos se marca como fallido en vez de ejecutarse otra vez.
  if (job.attempts > job.max_attempts) {
    await fail(db, job, 'Se interrumpió demasiadas veces.');
    return claim(db);
  }
  return job;
}

export async function complete(db: Db, id: string, result: unknown): Promise<void> {
  await db.query(`update jobs set status = 'done', result = $2, error = null, locked_until = null, updated_at = now() where id = $1`, [id, JSON.stringify(result ?? null)]);
}

/** Espera creciente: 30 s, 60 s, 120 s… */
export const backoffSeconds = (attempts: number) => Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);

export async function fail(db: Db, job: Pick<Job, 'id' | 'attempts' | 'max_attempts'>, error: string): Promise<'retry' | 'failed'> {
  const final = job.attempts >= job.max_attempts;
  await db.query(
    `update jobs set status = $2, error = $3, locked_until = null, run_after = now() + make_interval(secs => $4), updated_at = now() where id = $1`,
    [job.id, final ? 'failed' : 'queued', error.slice(0, 1000), final ? 0 : backoffSeconds(job.attempts)]);
  return final ? 'failed' : 'retry';
}

export async function listJobs(db: Db, userId: string, limit = 30): Promise<Job[]> {
  return (await db.query<Job>(`select ${COLS} from jobs where user_id = $1 order by created_at desc limit $2`, [userId, limit])).rows;
}

export async function retryJob(db: Db, userId: string, id: string): Promise<Job | null> {
  const r = await db.query<Job>(
    `update jobs set status = 'queued', attempts = 0, run_after = now(), error = null, updated_at = now()
     where id = $1 and user_id = $2 and status in ('failed', 'cancelled') returning ${COLS}`, [id, userId]);
  return r.rows[0] ?? null;
}

export async function cancelJob(db: Db, userId: string, id: string): Promise<Job | null> {
  const r = await db.query<Job>(
    `update jobs set status = 'cancelled', updated_at = now() where id = $1 and user_id = $2 and status = 'queued' returning ${COLS}`, [id, userId]);
  return r.rows[0] ?? null;
}
