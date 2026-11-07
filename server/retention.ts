import type { Db } from './db/pool.js';
import { allowAttempt, audit } from './audit.js';

/**
 * Retención: lo que ya no sirve, no se guarda. Cuanto menos tiempo vive un dato sensible en la base,
 * menos hay que proteger y menos se puede filtrar. Los plazos están documentados en docs/DATABASE.md
 * y en los comentarios de cada tabla (migración 002).
 */
export const RETENTION = {
  rateLimitsDays: 1,
  /** Tarjetas ya resueltas: a los 30 días se vacían args/result/undo (queda la fila para el historial); a los 180 se borra. */
  actionDetailDays: 30,
  actionDeleteDays: 180,
  /** Trabajos terminados: a los 14 días se vacían payload/result; a los 90 se borra la fila. */
  jobDetailDays: 14,
  jobDeleteDays: 90,
  /** Auditoría: la IP a los 90 días; la fila a los 365. */
  auditIpDays: 90,
  auditDeleteDays: 365
} as const;

export type PurgeReport = Record<string, number>;

/** Ejecuta toda la purga. Es idempotente: una segunda pasada seguida no encuentra nada. */
export async function purgeExpired(db: Db): Promise<PurgeReport> {
  const n = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rowCount ?? 0;
  const r: PurgeReport = {};

  r.sesiones = await n(`delete from sessions where expires_at < now()`);
  r.estadosOauth = await n(`delete from oauth_states where expires_at < now()`);
  r.limites = await n(`delete from rate_limits where window_start < now() - make_interval(days => $1)`, [RETENTION.rateLimitsDays]);

  // Una tarjeta pendiente que ya caducó deja de poder confirmarse.
  r.tarjetasCaducadas = await n(`update pending_actions set status = 'expired' where status = 'pending' and expires_at < now()`);
  // Primero se borra lo muy viejo y después se vacía el detalle de lo que queda (menos trabajo, recuentos exactos).
  r.tarjetasBorradas = await n(
    `delete from pending_actions where status <> 'pending' and created_at < now() - make_interval(days => $1)`, [RETENTION.actionDeleteDays]);
  r.tarjetasDepuradas = await n(
    `update pending_actions set args = '{}'::jsonb, result = null, undo = null
     where status <> 'pending' and created_at < now() - make_interval(days => $1)
       and (args <> '{}'::jsonb or result is not null or undo is not null)`, [RETENTION.actionDetailDays]);

  r.trabajosBorrados = await n(
    `delete from jobs where status in ('done', 'failed', 'cancelled') and updated_at < now() - make_interval(days => $1)`, [RETENTION.jobDeleteDays]);
  r.trabajosDepurados = await n(
    `update jobs set payload = '{}'::jsonb, result = null
     where status in ('done', 'failed', 'cancelled') and updated_at < now() - make_interval(days => $1)
       and (payload <> '{}'::jsonb or result is not null)`, [RETENTION.jobDetailDays]);

  r.auditoriaBorrada = await n(`delete from audit_log where created_at < now() - make_interval(days => $1)`, [RETENTION.auditDeleteDays]);
  r.ipAuditoria = await n(
    `update audit_log set detail = detail - 'ip' where created_at < now() - make_interval(days => $1) and detail ? 'ip'`, [RETENTION.auditIpDays]);
  return r;
}

/**
 * Como mucho una vez por hora, compartido entre instancias (la purga es barata, pero no hace falta en cada disparo).
 * Devuelve null si todavía no toca.
 */
export async function purgeIfDue(db: Db): Promise<PurgeReport | null> {
  if (!(await allowAttempt(db, 'purga-retencion', 1, 3600))) return null;
  const report = await purgeExpired(db);
  if (Object.values(report).some(v => v > 0)) await audit(db, null, 'retencion.purga', report);
  return report;
}
