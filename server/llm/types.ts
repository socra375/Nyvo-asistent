/** Esquema de parámetros de una herramienta (subconjunto de JSON Schema que acepta Gemini). */
export interface Schema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: string[];
  items?: Schema;
  format?: string;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
}

export interface FunctionDecl { name: string; description: string; parameters?: Schema }

export type Part =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface Turn { role: 'user' | 'model'; parts: Part[] }

export interface LlmRequest {
  system: string;
  turns: Turn[];
  tools?: FunctionDecl[];
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  calls: { name: string; args: Record<string, unknown> }[];
  /** Partes tal cual, para devolverlas al historial. */
  parts: Part[];
}

export interface Llm {
  generate(req: LlmRequest): Promise<LlmResponse>;
  /** Transcribe audio (voz a texto). */
  transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<string>;
}

const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);

/**
 * Convierte un JSON Schema arbitrario (p. ej. el de una herramienta MCP) al subconjunto que acepta Gemini.
 * Descarta claves desconocidas ($schema, additionalProperties, pattern…) y tipos compuestos.
 */
export function toLlmSchema(input: unknown, depth = 0): Schema {
  if (!input || typeof input !== 'object' || depth > 6) return { type: 'string' };
  const s = input as Record<string, unknown>;
  const out: Schema = {};
  let type = s.type;
  if (Array.isArray(type)) { if (type.includes('null')) out.nullable = true; type = type.find(t => t !== 'null'); }
  if (typeof type === 'string' && TYPES.has(type)) out.type = type as Schema['type'];
  else if (s.properties) out.type = 'object';
  else if (Array.isArray(s.enum)) out.type = 'string';
  else if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const first = ((s.anyOf ?? s.oneOf) as unknown[]).find(x => (x as Record<string, unknown>)?.type !== 'null');
    return { ...toLlmSchema(first, depth + 1), ...(typeof s.description === 'string' ? { description: s.description } : {}) };
  } else out.type = 'string';
  if (typeof s.description === 'string') out.description = s.description.slice(0, 1000);
  if (Array.isArray(s.enum)) out.enum = s.enum.filter(e => typeof e === 'string') as string[];
  if (typeof s.format === 'string' && ['date-time', 'enum'].includes(s.format)) out.format = s.format;
  if (typeof s.minimum === 'number') out.minimum = s.minimum;
  if (typeof s.maximum === 'number') out.maximum = s.maximum;
  if (out.type === 'object') {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toLlmSchema(v, depth + 1)]));
    if (Array.isArray(s.required)) out.required = (s.required as unknown[]).filter((r): r is string => typeof r === 'string' && r in props);
  }
  if (out.type === 'array') out.items = toLlmSchema(s.items, depth + 1);
  return out;
}

/** Nombre de función válido para Gemini: letras, números, _ . - (máx. 64). */
export const llmName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
