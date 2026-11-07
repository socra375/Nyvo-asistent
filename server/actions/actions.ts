import type { Deps } from '../deps.js';
import { connectorContext, getConnector } from '../../connectors/registry.js';
import { audit } from '../audit.js';
import { HttpError } from '../http/http.js';

export const CARD_TTL_MIN = 15;

export interface Card {
  id: string;
  kind: 'confirm' | 'undo';
  connector_id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: 'pending' | 'running' | 'done' | 'cancelled' | 'expired' | 'failed' | 'undone';
  result: unknown;
  error: string | null;
  expires_at: string;
  created_at: string;
}

const COLS = 'id, kind, connector_id, tool, args, summary, status, result, error, expires_at, created_at';

/** Campos de un resultado que sirven para el historial y el soporte (identificadores), nunca datos de clientes. */
const KEEP_IN_RESULT = ['id', 'pageId', 'url', 'number', 'status', 'estado', 'seccion'] as const;

/**
 * Lo que se guarda del resultado de una herramienta: solo identificadores y el tamaño. Nada del contenido.
 * Así la base de Nyvo no se convierte en una copia de los datos de AINova (clientes, cobros, facturas).
 * La aplicación no lee este campo: la deshacer usa `undo`, y el resultado completo ya se usó en memoria.
 */
export function slimResult(result: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    for (const k of KEEP_IN_RESULT) {
      const v = (result as Record<string, unknown>)[k];
      if ((typeof v === 'string' && v.length <= 300) || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
  }
  out.caracteres = JSON.stringify(result ?? null).length;
  return out;
}

/** Tarjeta de confirmación: la acción NO se ejecuta hasta que el usuario pulse «Confirmar». */
export async function createConfirmCard(deps: Deps, p: { userId: string; conversationId: string | null; connectorId: string; tool: string; args: Record<string, unknown>; summary: string }): Promise<Card> {
  const r = await deps.db.query<Card>(
    `insert into pending_actions (user_id, conversation_id, kind, connector_id, tool, args, summary, status, expires_at)
     values ($1, $2, 'confirm', $3, $4, $5, $6, 'pending', now() + make_interval(mins => $7)) returning ${COLS}`,
    [p.userId, p.conversationId, p.connectorId, p.tool, p.args, p.summary.slice(0, 500), CARD_TTL_MIN]);
  await audit(deps.db, p.userId, 'tarjeta.creada', { connector: p.connectorId, tool: p.tool });
  return r.rows[0]!;
}

/** Tarjeta «Deshacer» para una escritura aprobada de antemano (excepción del espacio Nyvo en Notion). */
export async function createUndoCard(deps: Deps, p: { userId: string; conversationId: string | null; connectorId: string; tool: string; args: Record<string, unknown>; summary: string; result: unknown; undo: Record<string, unknown> }): Promise<Card> {
  const r = await deps.db.query<Card>(
    `insert into pending_actions (user_id, conversation_id, kind, connector_id, tool, args, summary, status, result, undo, expires_at, decided_at)
     values ($1, $2, 'undo', $3, $4, $5, $6, 'done', $7, $8, now() + interval '7 days', now()) returning ${COLS}`,
    [p.userId, p.conversationId, p.connectorId, p.tool, p.args, p.summary.slice(0, 500), JSON.stringify(slimResult(p.result)), p.undo]);
  await audit(deps.db, p.userId, 'accion.auto', { connector: p.connectorId, tool: p.tool });
  return r.rows[0]!;
}

export async function expireCards(deps: Deps, userId: string): Promise<void> {
  await deps.db.query(`update pending_actions set status = 'expired' where user_id = $1 and status = 'pending' and expires_at < now()`, [userId]);
}

export async function listCards(deps: Deps, userId: string, opts: { ids?: string[]; limit?: number } = {}): Promise<Card[]> {
  await expireCards(deps, userId);
  if (opts.ids) {
    if (!opts.ids.length) return [];
    return (await deps.db.query<Card>(`select ${COLS} from pending_actions where user_id = $1 and id = any($2::uuid[]) order by created_at`, [userId, opts.ids])).rows;
  }
  return (await deps.db.query<Card>(`select ${COLS} from pending_actions where user_id = $1 order by created_at desc limit $2`, [userId, opts.limit ?? 50])).rows;
}

async function findTool(deps: Deps, userId: string, connectorId: string, toolName: string) {
  const { status, ctx } = await connectorContext(deps, userId, connectorId);
  if (status.state !== 'listo') throw new HttpError(409, `El conector ${status.title} no está listo (${status.state.replace('_', ' ')}).`);
  const tool = (await getConnector(connectorId)!.tools(ctx)).find(t => t.name === toolName);
  if (!tool) throw new HttpError(409, 'La herramienta ya no existe en el conector.');
  return { tool, ctx };
}

/** Ejecuta una acción confirmada. El cambio de estado es atómico: dos clics no la ejecutan dos veces. */
export async function confirmCard(deps: Deps, userId: string, id: string): Promise<Card> {
  await expireCards(deps, userId);
  const claimed = await deps.db.query<Card>(
    `update pending_actions set status = 'running', decided_at = now()
     where id = $1 and user_id = $2 and kind = 'confirm' and status = 'pending' returning ${COLS}`, [id, userId]);
  const card = claimed.rows[0];
  if (!card) throw new HttpError(409, 'La tarjeta ya no está pendiente (se confirmó, canceló o caducó).');
  try {
    const { tool, ctx } = await findTool(deps, userId, card.connector_id, card.tool);
    const result = await tool.run(card.args, ctx);
    await audit(deps.db, userId, 'accion.confirmada', { connector: card.connector_id, tool: card.tool }, true);
    return (await deps.db.query<Card>(`update pending_actions set status = 'done', result = $2 where id = $1 returning ${COLS}`, [id, JSON.stringify(slimResult(result))])).rows[0]!;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit(deps.db, userId, 'accion.confirmada', { connector: card.connector_id, tool: card.tool, error: msg }, false);
    return (await deps.db.query<Card>(`update pending_actions set status = 'failed', error = $2 where id = $1 returning ${COLS}`, [id, msg.slice(0, 300)])).rows[0]!;
  }
}

export async function cancelCard(deps: Deps, userId: string, id: string): Promise<Card> {
  const r = await deps.db.query<Card>(
    `update pending_actions set status = 'cancelled', decided_at = now() where id = $1 and user_id = $2 and status = 'pending' returning ${COLS}`, [id, userId]);
  if (!r.rows[0]) throw new HttpError(409, 'La tarjeta ya no está pendiente.');
  await audit(deps.db, userId, 'accion.cancelada', { connector: r.rows[0].connector_id, tool: r.rows[0].tool });
  return r.rows[0];
}

export async function undoCard(deps: Deps, userId: string, id: string): Promise<Card> {
  const r = await deps.db.query<Card & { undo: Record<string, unknown> | null }>(
    `update pending_actions set status = 'running' where id = $1 and user_id = $2 and kind = 'undo' and status = 'done' returning ${COLS}, undo`, [id, userId]);
  const card = r.rows[0];
  if (!card?.undo) throw new HttpError(409, 'Esta acción ya no se puede deshacer.');
  try {
    const connector = getConnector(card.connector_id);
    if (!connector?.undo) throw new Error('El conector no admite deshacer.');
    const { ctx } = await connectorContext(deps, userId, card.connector_id);
    await connector.undo(card.undo, ctx);
    await audit(deps.db, userId, 'accion.deshecha', { connector: card.connector_id, tool: card.tool });
    return (await deps.db.query<Card>(`update pending_actions set status = 'undone' where id = $1 returning ${COLS}`, [id])).rows[0]!;
  } catch (e) {
    await deps.db.query(`update pending_actions set status = 'done' where id = $1`, [id]);
    throw new HttpError(502, `No se pudo deshacer: ${e instanceof Error ? e.message : e}`);
  }
}
