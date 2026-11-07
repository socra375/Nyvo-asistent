import type { Connector, PanelItem, Tool, ToolContext } from '../types.js';
import { googleAccessToken, GOOGLE_ENV } from '../../server/auth/google.js';

/** Solo metadatos (nombre, tipo, fecha, enlace): Nyvo no lee ni cambia el contenido de los archivos en la fase 1. */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.metadata.readonly'];
const FIELDS = 'files(id,name,mimeType,modifiedTime,webViewLink,starred,owners(displayName))';

interface DriveFile { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string; starred?: boolean }

const KIND: Record<string, string> = {
  'application/vnd.google-apps.document': 'Doc',
  'application/vnd.google-apps.spreadsheet': 'Hoja',
  'application/vnd.google-apps.presentation': 'Diapositivas',
  'application/vnd.google-apps.folder': 'Carpeta',
  'application/pdf': 'PDF'
};
export const kindOf = (mime: string) => KIND[mime] ?? (mime.startsWith('image/') ? 'Imagen' : 'Archivo');

/** Escapa un texto para la sintaxis de consulta de Drive (comillas simples y barras). */
export const driveEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function list(ctx: ToolContext, q: string, orderBy: string, pageSize: number): Promise<DriveFile[]> {
  const token = await googleAccessToken(ctx.deps, ctx.userId);
  const p = new URLSearchParams({ q, orderBy, pageSize: String(pageSize), fields: FIELDS, spaces: 'drive' });
  const r = await ctx.deps.fetch(`${ctx.deps.cfg.urls.googleDrive}/drive/v3/files?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctx.signal });
  if (!r.ok) throw new Error(`Google Drive respondió ${r.status}`);
  return ((await r.json()) as { files?: DriveFile[] }).files ?? [];
}

const view = (f: DriveFile) => ({ id: f.id, nombre: f.name, tipo: kindOf(f.mimeType), modificado: f.modifiedTime, enlace: f.webViewLink, destacado: Boolean(f.starred) });

/** Archivos principales: primero los destacados, luego los modificados recientemente (sin repetir). */
export async function mainFiles(ctx: ToolContext, limit = 12): Promise<DriveFile[]> {
  const [starred, recent] = await Promise.all([
    list(ctx, 'starred = true and trashed = false', 'modifiedTime desc', limit),
    list(ctx, 'trashed = false', 'modifiedTime desc', limit)
  ]);
  const seen = new Set<string>();
  return [...starred, ...recent].filter(f => (seen.has(f.id) ? false : (seen.add(f.id), true))).slice(0, limit);
}

const tools: Tool[] = [
  {
    name: 'archivos_principales',
    description: 'Lista los archivos principales de Google Drive (destacados y recientes) con su enlace.',
    parameters: { type: 'object', properties: {} },
    mutates: false,
    run: async (_a, ctx) => (await mainFiles(ctx)).map(view)
  },
  {
    name: 'buscar_archivos',
    description: 'Busca archivos de Google Drive por nombre.',
    parameters: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] },
    mutates: false,
    run: async (a, ctx) => {
      const name = String(a.nombre ?? '').trim().slice(0, 100);
      if (!name) throw new Error('Falta «nombre».');
      return (await list(ctx, `name contains '${driveEscape(name)}' and trashed = false`, 'modifiedTime desc', 15)).map(view);
    }
  }
];

export const googleDrive: Connector = {
  id: 'google-drive',
  title: 'Google Drive',
  description: 'Archivos principales de la empresa (solo lectura de metadatos).',
  role: 'documentos',
  guide: 'Úsalo para encontrar documentos, hojas o presentaciones de la empresa y dar su enlace. En esta fase no lee ni modifica el contenido de los archivos.',
  requiredEnv: GOOGLE_ENV,
  google: { scopes: DRIVE_SCOPES },
  tools: () => tools
};

export async function drivePanel(ctx: ToolContext): Promise<PanelItem[]> {
  return (await mainFiles(ctx)).map(f => ({
    id: f.id, title: f.name, subtitle: f.modifiedTime ? f.modifiedTime.slice(0, 10) : undefined,
    url: f.webViewLink, badge: f.starred ? `★ ${kindOf(f.mimeType)}` : kindOf(f.mimeType)
  }));
}
