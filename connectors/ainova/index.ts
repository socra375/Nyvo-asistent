import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Connector, Tool, ToolContext } from '../types.js';
import { toLlmSchema } from '../../server/llm/types.js';

export const AINOVA_ENV = ['AINOVA_MCP_URL', 'AINOVA_MCP_TOKEN'] as const;

/** Herramientas de AINova que nunca se exponen a Nyvo (no son de «Mis negocios» o son de otro asistente). */
const HIDDEN = new Set(['add_agent_item']);

interface McpTool { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }

/** Abre una sesión MCP con AINova (Streamable HTTP, token Bearer propio de Nyvo). */
async function withClient<T>(ctx: ToolContext, fn: (c: Client) => Promise<T>): Promise<T> {
  const env = ctx.deps.cfg.env;
  const url = new URL(env.AINOVA_MCP_URL!);
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: ctx.deps.fetch,
    requestInit: { headers: { Authorization: `Bearer ${env.AINOVA_MCP_TOKEN}` } }
  });
  const client = new Client({ name: 'nyvo', version: '0.1.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Convierte el resultado MCP (texto JSON) en datos. */
export function parseMcpResult(r: unknown): unknown {
  const res = r as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  if (res.isError) throw new Error(text || 'AINova devolvió un error.');
  try { return JSON.parse(text); } catch { return text; }
}

export async function callAinova(ctx: ToolContext, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return withClient(ctx, async c => parseMcpResult(await c.callTool({ name, arguments: args }, undefined, { signal: ctx.signal })));
}

export function toTool(t: McpTool): Tool {
  // Sin readOnlyHint explícito se trata como escritura: pide confirmación.
  const mutates = t.annotations?.readOnlyHint !== true;
  return {
    name: t.name,
    description: (t.description ?? t.name).replace(/\s*Pide confirmación al usuario antes de llamarla[^.]*\./g, '').trim(),
    parameters: toLlmSchema(t.inputSchema ?? { type: 'object', properties: {} }),
    mutates,
    summarize: args => `AINova · ${t.name.replace(/_/g, ' ')} ${JSON.stringify(args)}`.slice(0, 300),
    run: (args, ctx) => callAinova(ctx, t.name, args)
  };
}

export const ainova: Connector = {
  id: 'ainova',
  title: 'AINova System',
  description: 'Clientes, proyectos, cobros, servicios y chat con clientes del panel de AINova.',
  role: 'negocios',
  guide: 'Úsalo para todo lo de clientes, proyectos, cobros pendientes o pagados, servicios contratados y conversaciones con clientes. Es la fuente de verdad: no inventes datos que no devuelva. Responder a un cliente, marcar un cobro o registrar una interacción cambia datos y requiere confirmación.',
  requiredEnv: AINOVA_ENV,
  async tools(ctx) {
    const list = await withClient(ctx, c => c.listTools(undefined, { signal: ctx.signal }));
    return (list.tools as McpTool[]).filter(t => !HIDDEN.has(t.name)).map(toTool);
  }
};

export interface ClientsPanel {
  summary: Record<string, unknown> | null;
  clients: { id: string; name: string; company?: string; email?: string; status?: string }[];
}

/** Datos del panel «Clientes» (solo lectura). */
export async function clientsPanel(ctx: ToolContext, query?: string): Promise<ClientsPanel> {
  return withClient(ctx, async c => {
    const summary = parseMcpResult(await c.callTool({ name: 'get_summary', arguments: {} })) as Record<string, unknown>;
    const list = parseMcpResult(await c.callTool({ name: 'search_clients', arguments: query ? { query } : {} }));
    return { summary, clients: Array.isArray(list) ? list as ClientsPanel['clients'] : [] };
  });
}
