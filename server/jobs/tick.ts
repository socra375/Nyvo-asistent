import type { Deps } from '../deps.js';
import { claim, complete, fail, type Job } from './queue.js';
import { runSpecialist, SPECIALISTS, type SpecialistId } from '../agents/specialists.js';
import { addMessage } from '../agents/conversations.js';

export type JobHandler = (deps: Deps, job: Job, remainingMs: number) => Promise<unknown>;

/** Tipos de trabajo en segundo plano. */
export const HANDLERS: Record<string, JobHandler> = {
  /** Una tarea larga de un especialista; al terminar deja la respuesta en la conversación. */
  async especialista(deps, job, remainingMs) {
    const specialist = String(job.payload.especialista) as SpecialistId;
    if (!(specialist in SPECIALISTS)) throw new Error('Especialista desconocido.');
    const res = await runSpecialist(deps, {
      userId: job.user_id!, conversationId: job.conversation_id, specialist,
      task: String(job.payload.tarea ?? ''), deadlineMs: Math.min(remainingMs - 2000, deps.cfg.limits.jobsTickBudgetMs)
    });
    if (job.conversation_id) {
      await addMessage(deps.db, job.user_id!, job.conversation_id, 'assistant',
        `Trabajo terminado: «${job.title}».\n\n${res.text}`, res.cards.map(c => c.id));
    }
    return { texto: res.text, tarjetas: res.cards.map(c => c.id), parcial: res.partial };
  }
};

/**
 * Procesa trabajos durante un presupuesto de tiempo (≤ 45 s, por debajo del corte de 60 s de Vercel).
 * Si la instancia muere, el bloqueo vence y otro tick lo reintenta.
 */
export async function runTick(deps: Deps, budgetMs = deps.cfg.limits.jobsTickBudgetMs): Promise<{ processed: number; failed: number }> {
  const end = Date.now() + budgetMs;
  let processed = 0;
  let failed = 0;
  while (Date.now() < end - 5000) {
    const job = await claim(deps.db);
    if (!job) break;
    const handler = HANDLERS[job.kind];
    try {
      if (!handler) throw new Error(`Tipo de trabajo desconocido: ${job.kind}`);
      await complete(deps.db, job.id, await handler(deps, job, end - Date.now()));
      processed++;
    } catch (e) {
      const outcome = await fail(deps.db, job, e instanceof Error ? e.message : String(e));
      if (outcome === 'failed') failed++;
    }
  }
  return { processed, failed };
}
