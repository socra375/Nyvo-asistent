import type { ToolContext } from '../types.js';

/** Cliente mínimo de la API de GitHub para leer y escribir la bóveda de Obsidian (un repositorio privado). El token nunca sale de aquí. */
const API_VERSION = '2022-11-28';
export interface TreeItem { path: string; sha: string; size: number }

export function vaultConfig(ctx: ToolContext) {
  const env = ctx.deps.cfg.env;
  const repo = (env.OBSIDIAN_REPO ?? '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('OBSIDIAN_REPO debe tener la forma «usuario/repositorio».');
  return { repo, branch: (env.OBSIDIAN_BRANCH ?? '').trim() || 'main', token: env.OBSIDIAN_GITHUB_TOKEN!, base: ctx.deps.cfg.urls.github };
}

async function gh(ctx: ToolContext, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const c = vaultConfig(ctx);
  const r = await ctx.deps.fetch(`${c.base}/repos/${c.repo}${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'nyvo-asistente', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: ctx.signal
  });
  const data = await r.json().catch(() => ({})) as Record<string, unknown>;
  return { status: r.status, data };
}
const fail = (status: number, data: Record<string, unknown>): never => {
  const why = status === 401 || status === 403 ? 'rechazó el token (¿caducó o no tiene permiso de «Contents» sobre este repositorio?)'
    : status === 404 ? 'no encuentra el repositorio o el archivo (¿nombre mal escrito o el token no lo ve?)'
    : status === 409 || status === 422 ? 'detectó un conflicto: la nota cambió mientras tanto; inténtalo otra vez'
    : `respondió ${status}${typeof data.message === 'string' ? `: ${data.message.slice(0, 120)}` : ''}`;
  throw new Error(`GitHub ${why}.`);
};
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Lista de archivos de la bóveda. Un repositorio vacío cuenta como bóveda vacía. */
export async function getTree(ctx: ToolContext): Promise<TreeItem[]> {
  const { branch } = vaultConfig(ctx);
  const { status, data } = await gh(ctx, 'GET', `/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (status === 409) return [];
  if (status !== 200) fail(status, data);
  const tree = (data.tree as { path: string; type: string; sha: string; size?: number }[] | undefined) ?? [];
  return tree.filter(t => t.type === 'blob').map(t => ({ path: t.path, sha: t.sha, size: t.size ?? 0 }));
}

export async function getFile(ctx: ToolContext, path: string): Promise<{ text: string; sha: string } | null> {
  const { branch } = vaultConfig(ctx);
  const { status, data } = await gh(ctx, 'GET', `/contents/${enc(path)}?ref=${encodeURIComponent(branch)}`);
  if (status === 404) return null;
  if (status !== 200) fail(status, data);
  return { text: Buffer.from(String(data.content ?? ''), 'base64').toString('utf8'), sha: String(data.sha) };
}

export async function putFile(ctx: ToolContext, path: string, text: string, message: string, sha?: string): Promise<{ sha: string; commit: string }> {
  const { branch } = vaultConfig(ctx);
  const { status, data } = await gh(ctx, 'PUT', `/contents/${enc(path)}`, { message, content: Buffer.from(text, 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) });
  if (status !== 200 && status !== 201) fail(status, data);
  return { sha: String((data.content as { sha: string }).sha), commit: String((data.commit as { sha: string }).sha) };
}

export async function deleteFile(ctx: ToolContext, path: string, sha: string, message: string): Promise<void> {
  const { branch } = vaultConfig(ctx);
  const { status, data } = await gh(ctx, 'DELETE', `/contents/${enc(path)}`, { message, sha, branch });
  if (status !== 200) fail(status, data);
}
