import { LlmHttpError, type FunctionDecl, type Llm, type LlmRequest, type LlmResponse, type Part, type Schema, type Turn } from './types.js';

/**
 * Motor de IA con la API «chat/completions» compatible con OpenAI (Groq, OpenRouter…).
 * El historial de Nyvo está en un formato neutro (partes de texto, llamadas y respuestas de funciones): aquí se traduce
 * a mensajes, de modo que se puede cambiar de motor a mitad de una conversación.
 * El formato sale de lo que se conoce de esa API; NO se ha verificado contra los servicios reales.
 */
export interface CompatOpts { name: string; apiKey: string; model: string; baseUrl: string; fetch: typeof fetch; headers?: Record<string, string> }

type Msg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const textOf = (parts: Part[]) => parts.map(p => ('text' in p ? p.text : '')).join('');

export function toOpenAiMessages(system: string, turns: Turn[]): Msg[] {
  const out: Msg[] = [{ role: 'system', content: system }];
  let n = 0;
  let pending: { id: string; name: string }[] = [];
  for (const t of turns) {
    if (t.role === 'model') {
      const calls = t.parts.flatMap(p => ('functionCall' in p ? [p.functionCall] : []));
      pending = calls.map(c => ({ id: `call_${++n}`, name: c.name }));
      out.push({
        role: 'assistant', content: textOf(t.parts) || null,
        ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: pending[i]!.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {})
      });
      continue;
    }
    for (const p of t.parts) {
      if (!('functionResponse' in p)) continue;
      const i = pending.findIndex(q => q.name === p.functionResponse.name);
      if (i >= 0) out.push({ role: 'tool', tool_call_id: pending.splice(i, 1)[0]!.id, content: JSON.stringify(p.functionResponse.response) });
      else out.push({ role: 'user', content: `Resultado de ${p.functionResponse.name}: ${JSON.stringify(p.functionResponse.response)}` });   // sin llamada previa: no se puede emparejar
    }
    const text = textOf(t.parts);
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

/** Esquema sin las claves que no todos los proveedores aceptan (format, nullable). */
function cleanSchema(s: Schema | undefined): Record<string, unknown> {
  if (!s) return { type: 'object', properties: {} };
  const { format: _f, nullable: _n, properties, items, ...rest } = s;
  void _f; void _n;
  const out: Record<string, unknown> = { ...rest };
  if (properties) out.properties = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, cleanSchema(v)]));
  if (items) out.items = cleanSchema(items);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}
export const toOpenAiTools = (tools: FunctionDecl[]) => tools.map(f => ({ type: 'function' as const, function: { name: f.name, description: f.description, parameters: cleanSchema(f.parameters) } }));

export function createOpenAiCompat(o: CompatOpts): Llm {
  return {
    async generate(req: LlmRequest): Promise<LlmResponse> {
      const body: Record<string, unknown> = { model: o.model, messages: toOpenAiMessages(req.system, req.turns), temperature: 0.4 };
      if (req.tools?.length) { body.tools = toOpenAiTools(req.tools); body.tool_choice = 'auto'; }
      const r = await o.fetch(`${o.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}`, ...o.headers }, body: JSON.stringify(body), signal: req.signal
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new LlmHttpError(`${o.name} respondió ${r.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, r.status);
      }
      const j = await r.json().catch(() => null) as { choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] } | null;
      const msg = j?.choices?.[0]?.message;
      if (!msg) throw new LlmHttpError(`${o.name} no devolvió respuesta.`, 502);
      const text = (msg.content ?? '').trim();
      const calls = (msg.tool_calls ?? []).flatMap(c => {
        if (!c.function?.name) return [];
        let args: Record<string, unknown> = {};
        try { const v = JSON.parse(c.function.arguments || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) args = v as Record<string, unknown>; } catch { /* argumentos mal formados: se llama sin ellos */ }
        return [{ name: c.function.name, args }];
      });
      if (!text && !calls.length) throw new LlmHttpError(`${o.name} devolvió una respuesta vacía.`, 502);
      return { text, calls, parts: [...(text ? [{ text }] : []), ...calls.map(c => ({ functionCall: c }))], engine: o.name };
    },
    async transcribe() { throw new Error(`${o.name} no transcribe aquí: la escucha usa Groq Whisper o Gemini.`); }
  };
}
