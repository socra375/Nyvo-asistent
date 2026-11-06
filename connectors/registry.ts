import type { Connector, ConnectorStatus, Role, Tool, ToolContext } from './types.js';
import type { Deps } from '../server/deps.js';
import { missingEnv } from '../server/config.js';
import { googleScopes } from '../server/auth/google.js';
import { llmName } from '../server/llm/types.js';
import { ainova } from './ainova/index.js';
import { notionConnector } from './notion/index.js';
import { googleDrive } from './google-drive/index.js';
import { memoria } from './memoria/index.js';
import { gemini } from './gemini/index.js';
import { voz } from './voz/index.js';

/** Todos los conectores de la fase 1. Para añadir uno: crear connectors/<id>/ y sumarlo aquí. */
export const CONNECTORS: readonly Connector[] = [ainova, notionConnector, googleDrive, memoria, gemini, voz];

export const getConnector = (id: string) => CONNECTORS.find(c => c.id === id);

interface UserConnState { enabled: Map<string, boolean>; settings: Map<string, Record<string, unknown>>; scopes: string[] }

async function userState(deps: Deps, userId: string): Promise<UserConnState> {
  const r = await deps.db.query<{ connector_id: string; enabled: boolean; settings: Record<string, unknown> }>(
    'select connector_id, enabled, settings from connector_settings where user_id = $1', [userId]);
  return {
    enabled: new Map(r.rows.map(x => [x.connector_id, x.enabled])),
    settings: new Map(r.rows.map(x => [x.connector_id, x.settings])),
    scopes: await googleScopes(deps, userId)
  };
}

export function statusOf(c: Connector, env: Record<string, string | undefined>, st: UserConnState): ConnectorStatus {
  const required = c.envFor ? c.envFor(env) : c.requiredEnv;
  const missing = missingEnv(env, required);
  const missingScopes = (c.google?.scopes ?? []).filter(s => !st.scopes.includes(s));
  const enabled = st.enabled.get(c.id) ?? true;
  const state = missing.length ? 'falta_configurar' : missingScopes.length ? 'falta_conectar' : enabled ? 'listo' : 'desactivado';
  return {
    id: c.id, title: c.title, description: c.description, role: c.role, guide: c.guide,
    requiredEnv: required, state, missingEnv: missing, missingScopes,
    settings: { ...(c.defaultSettings ?? {}), ...(st.settings.get(c.id) ?? {}) }
  };
}

export async function connectorStatuses(deps: Deps, userId: string): Promise<ConnectorStatus[]> {
  const st = await userState(deps, userId);
  return CONNECTORS.map(c => statusOf(c, deps.cfg.env, st));
}

export async function connectorContext(deps: Deps, userId: string, id: string, signal?: AbortSignal): Promise<{ status: ConnectorStatus; ctx: ToolContext }> {
  const c = getConnector(id);
  if (!c) throw new Error(`Conector desconocido: ${id}`);
  const status = statusOf(c, deps.cfg.env, await userState(deps, userId));
  return { status, ctx: { deps, userId, settings: status.settings, signal } };
}

export interface BoundTool { fullName: string; connectorId: string; tool: Tool; ctx: ToolContext }

/**
 * Arma el conjunto de herramientas de un especialista con lo que el usuario tiene conectado.
 * Los conectores sin configurar se omiten (y se informan aparte), nunca rompen la petición.
 */
export async function toolsForRole(deps: Deps, userId: string, role: Role, signal?: AbortSignal): Promise<{ tools: BoundTool[]; unavailable: { id: string; title: string; state: string; error?: string }[]; guides: string[] }> {
  const st = await userState(deps, userId);
  const tools: BoundTool[] = [];
  const unavailable: { id: string; title: string; state: string; error?: string }[] = [];
  const guides: string[] = [];
  for (const c of CONNECTORS.filter(x => x.role === role || (x.role === 'nucleo' && x.id === 'memoria'))) {
    const s = statusOf(c, deps.cfg.env, st);
    if (s.state !== 'listo') { unavailable.push({ id: c.id, title: c.title, state: s.state }); continue; }
    const ctx: ToolContext = { deps, userId, settings: s.settings, signal };
    try {
      const list = await c.tools(ctx);
      if (list.length) guides.push(`- ${c.title}: ${c.guide}`);
      for (const t of list) tools.push({ fullName: llmName(`${c.id}__${t.name}`), connectorId: c.id, tool: t, ctx });
    } catch (e) {
      unavailable.push({ id: c.id, title: c.title, state: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { tools, unavailable, guides };
}

export async function saveConnectorSettings(deps: Deps, userId: string, id: string, enabled: boolean | undefined, settings: Record<string, unknown> | undefined): Promise<void> {
  await deps.db.query(
    `insert into connector_settings (user_id, connector_id, enabled, settings) values ($1, $2, coalesce($3, true), coalesce($4, '{}'::jsonb))
     on conflict (user_id, connector_id) do update set
       enabled = coalesce($3, connector_settings.enabled),
       settings = connector_settings.settings || coalesce($4, '{}'::jsonb), updated_at = now()`,
    [userId, id, enabled ?? null, settings ? JSON.stringify(settings) : null]);
}
