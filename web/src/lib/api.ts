/** Cliente de la API de Nyvo. El navegador nunca ve claves: solo habla con /api del mismo origen. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  if (r.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
  if (!r.ok) {
    const e = await r.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(r.status, e.error ?? `Error ${r.status}`, e.code);
  }
  return await r.json() as T;
}

export interface User { id: string; email: string; name: string | null }
export interface SessionInfo { user: User | null; googleLogin: boolean; ownerConfigured: boolean }

export type ConnectorState = 'listo' | 'falta_configurar' | 'falta_conectar' | 'desactivado';
export interface ConnectorStatus {
  id: string; title: string; description: string; role: string; guide: string;
  requiredEnv: string[]; state: ConnectorState; missingEnv: string[]; missingScopes: string[]; settings: Record<string, unknown>;
}

export interface PanelResponse<T> { state: ConnectorState | 'error'; data?: T; missingEnv?: string[]; missingScopes?: string[]; error?: string }
export interface PanelItem { id: string; title: string; subtitle?: string; url?: string; badge?: string }
export interface Client { id: string; name: string; company?: string | null; email?: string | null; status?: string }
export interface ClientsData { summary: { activeClients?: number; activeProjects?: number; collected?: string; pending?: string } | null; clients: Client[] }

export interface Card {
  id: string; kind: 'confirm' | 'undo'; connector_id: string; tool: string; args: Record<string, unknown>;
  summary: string; status: 'pending' | 'running' | 'done' | 'cancelled' | 'expired' | 'failed' | 'undone';
  result: unknown; error: string | null; expires_at: string; created_at: string;
}
export interface Message { id: string; role: 'user' | 'assistant'; content: string; card_ids: string[]; created_at: string }
export interface Conversation { id: string; title: string; updated_at: string }
export interface Job {
  id: string; kind: string; title: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number; max_attempts: number; error: string | null; created_at: string; updated_at: string;
}
export interface Note { id: string; content: string; tags: string[]; created_at: string }
export interface Style { description: string; samples: string[]; updated_at: string | null }
export interface ServerVoice { id: string; name: string; default?: boolean }
export interface VoiceConfig { provider: string; voices?: ServerVoice[]; missingEnv: string[]; maxChars: number; stt: boolean; sttProvider?: string; sttMissing?: string[]; wakeWord: string }

export const fmtDate = (iso: string) => new Date(iso).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const money = (v: string | undefined) => (v === undefined ? '—' : `${Number(v).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`);

export type Hemisphere = 'rose' | 'johan' | 'mia' | 'nyvo';
export const HEMISPHERES: readonly Hemisphere[] = ['rose', 'johan', 'mia', 'nyvo'];
export type ChatEvent =
  | { tipo: 'pensando' }
  | { tipo: 'hemisferio'; id: Hemisphere; estado: 'activo' | 'listo'; herramienta: string; /** Cuánto tardó (solo al terminar). */ ms?: number }
  | { tipo: 'fin'; conversationId: string; reply: string; cards: Card[]; jobIds: string[]; partial: boolean; timing?: { totalMs?: number; via?: string } }
  | { tipo: 'error'; status: number; mensaje: string };

/** Chat con progreso en vivo (NDJSON): llama a onEvent por cada línea y devuelve el evento final. */
export async function streamChat(body: { message: string; conversationId: string | null; voice: boolean }, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<Extract<ChatEvent, { tipo: 'fin' }>> {
  const r = await fetch('/api/chat/stream', {
    method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (r.status === 401) onUnauthorized();
  if (!r.ok || !r.body) {
    const e = await r.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(r.status, e.error ?? `Error ${r.status}`, e.code);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let last: Extract<ChatEvent, { tipo: 'fin' }> | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const e = JSON.parse(line) as ChatEvent;
    if (e.tipo === 'error') throw new ApiError(e.status, e.mensaje);
    if (e.tipo === 'fin') last = e;
    onEvent(e);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    if (done) break;
  }
  handle(buf);
  if (!last) throw new ApiError(502, 'La respuesta se cortó antes de terminar. Inténtalo de nuevo.');
  return last;
}
