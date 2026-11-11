import { LlmHttpError, type FunctionDecl, type Llm, type LlmRequest, type LlmResponse, type Part, type Schema, type Turn } from './types.js';

/**
 * Motor de IA con la API «chat/completions» compatible con OpenAI (Groq, OpenRouter…).
 * El historial de Nyvo está en un formato neutro (partes de texto, llamadas y respuestas de funciones): aquí se traduce
 * a mensajes, de modo que se puede cambiar de motor a mitad de una conversación.
 * El formato sale de lo que se conoce de esa API; NO se ha verificado contra los servicios reales.
 */
export interface CompatOpts { name: string; apiKey: string; model: string; baseUrl: string; fetch: typeof fetch; headers?: Record<string, string>; /** Esfuerzo de razonamiento («low» gasta menos cuota; solo modelos que lo admiten). */ reasoningEffort?: 'low' | 'medium' | 'high'; /** Tope aproximado de tokens de entrada por petición: se recortan los mensajes más antiguos. */ maxInputTokens?: number; /** Si el proveedor retira el modelo, se pide su lista y se pasa al primero de estas preferencias que siga disponible (texto exacto o patrón). */ modelPreferences?: (string | RegExp)[] }

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

/** Modelos que no sirven para chatear (transcripción, voz, moderación, embeddings…): nunca se eligen como reemplazo. */
const NON_CHAT_MODELS = /whisper|tts|guard|embed|playai|orpheus|compound|distil/i;
/** ¿La respuesta dice que el modelo ya no existe (lo retiran cada pocos meses)? */
export const isMissingModel = (status: number, detail: string) =>
  (status === 404 || status === 400) && /model_not_found|model_decommissioned|does not exist|decommissioned|no longer supported/i.test(detail);

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


const PSEUDO = /<\/?(?:function_calls|invoke|parameter)\b|<\|?tool_call/i;
/**
 * Algunos modelos pequeños escriben la llamada a la herramienta COMO TEXTO (`<function_calls><invoke name="…">…`) en vez de usar
 * `tool_calls`. Si el nombre es una herramienta declarada se convierte en llamada real; el resto del texto se conserva.
 * Si queda marcado pero no se puede interpretar, devuelve `broken` para que la rotación pruebe otro motor y no se lea en voz alta.
 */
export function extractTextToolCalls(text: string, tools: FunctionDecl[] | undefined): { text: string; calls: { name: string; args: Record<string, unknown> }[]; broken: boolean } {
  if (!PSEUDO.test(text)) return { text, calls: [], broken: false };
  const known = new Set((tools ?? []).map(t => t.name));
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const decode = (v: string) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
  let rest = text.replace(/<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/gi, (_m, name: string, inner: string) => {
    if (known.has(name)) {
      const args: Record<string, unknown> = {};
      for (const m of inner.matchAll(/<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi)) args[m[1]!] = decode(m[2]!);
      calls.push({ name, args });
    }
    return '';
  });
  rest = rest.replace(/<\/?function_calls>/gi, '').trim();
  return { text: rest, calls, broken: PSEUDO.test(rest) };
}

const CHARS_PER_TOKEN = 3.5;
const sizeOf = (t: Turn) => JSON.stringify(t.parts).length;
const isPlainUser = (t: Turn) => t.role === 'user' && t.parts.every(p => 'text' in p);

/**
 * Recorta el historial más antiguo para no pasar de ~maxTokens de entrada (sistema + mensajes). Nunca toca la petición actual
 * (el último mensaje de texto del usuario y todo lo que va después, que incluye las llamadas a herramientas en curso) y el
 * historial recortado siempre empieza en un mensaje de texto del usuario, para no dejar respuestas de herramientas huérfanas.
 */
export function trimTurns(system: string, turns: Turn[], maxTokens: number): Turn[] {
  const budget = maxTokens * CHARS_PER_TOKEN - system.length;
  let keepFrom = 0;
  for (let i = turns.length - 1; i >= 0; i--) if (isPlainUser(turns[i]!)) { keepFrom = i; break; }
  let total = turns.reduce((n, t) => n + sizeOf(t), 0);
  let start = 0;
  while (total > budget && start < keepFrom) {
    total -= sizeOf(turns[start]!); start++;
    while (start < keepFrom && !isPlainUser(turns[start]!)) { total -= sizeOf(turns[start]!); start++; }
  }
  return start ? turns.slice(start) : turns;
}

export function createOpenAiCompat(o: CompatOpts): Llm {
  let model = o.model;   // cambia solo si el proveedor retira el modelo y se encuentra otro (se recuerda mientras viva la instancia)

  /** Pide la lista de modelos del proveedor y elige el primero preferido que siga disponible y sirva para chatear. */
  async function findReplacement(signal?: AbortSignal): Promise<string | null> {
    if (!o.modelPreferences?.length) return null;
    try {
      const r = await o.fetch(`${o.baseUrl}/models`, { headers: { Authorization: `Bearer ${o.apiKey}`, ...o.headers }, signal });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null) as { data?: { id?: unknown }[] } | null;
      const ids = (j?.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string' && !NON_CHAT_MODELS.test(id) && id !== model);
      for (const pref of o.modelPreferences) {
        const hit = ids.find(id => (typeof pref === 'string' ? id === pref : pref.test(id)));
        if (hit) return hit;
      }
    } catch { /* sin lista no hay reemplazo: se informa el error original */ }
    return null;
  }

  return {
    async generate(req: LlmRequest): Promise<LlmResponse> {
      const turns = o.maxInputTokens ? trimTurns(req.system, req.turns, o.maxInputTokens) : req.turns;
      const body: Record<string, unknown> = { model, messages: toOpenAiMessages(req.system, turns), temperature: 0.4 };
      if (req.tools?.length) { body.tools = toOpenAiTools(req.tools); body.tool_choice = 'auto'; }
      const post = () => o.fetch(`${o.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}`, ...o.headers }, body: JSON.stringify(body), signal: req.signal
      });
      if (o.reasoningEffort) body.reasoning_effort = o.reasoningEffort;
      let r = await post();
      let detail = r.ok ? '' : await r.text().catch(() => '');
      if (!r.ok && r.status === 400 && body.reasoning_effort && /reasoning/i.test(detail)) {   // el modelo no admite ese parámetro: se reintenta sin él
        delete body.reasoning_effort;
        r = await post();
        detail = r.ok ? '' : await r.text().catch(() => '');
      }
      if (!r.ok && isMissingModel(r.status, detail)) {
        const found = await findReplacement(req.signal);
        if (found) {
          console.warn(`${o.name} ya no ofrece «${model}»: paso a «${found}» (fija ${o.name.toUpperCase()}_MODEL para no depender de esto)`);
          model = found; body.model = found;
          r = await post();
          detail = r.ok ? '' : await r.text().catch(() => '');
        }
      }
      if (!r.ok) throw new LlmHttpError(`${o.name} respondió ${r.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, r.status);
      const j = await r.json().catch(() => null) as { choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] } | null;
      const msg = j?.choices?.[0]?.message;
      if (!msg) throw new LlmHttpError(`${o.name} no devolvió respuesta.`, 502);
      let text = (msg.content ?? '').trim();
      const calls = (msg.tool_calls ?? []).flatMap(c => {
        if (!c.function?.name) return [];
        let args: Record<string, unknown> = {};
        try { const v = JSON.parse(c.function.arguments || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) args = v as Record<string, unknown>; } catch { /* argumentos mal formados: se llama sin ellos */ }
        return [{ name: c.function.name, args }];
      });
      if (!calls.length) {
        const x = extractTextToolCalls(text, req.tools);
        if (x.broken) throw new LlmHttpError(`${o.name} escribió la llamada a la herramienta como texto.`, 502);
        text = x.text; calls.push(...x.calls);
      }
      if (!text && !calls.length) throw new LlmHttpError(`${o.name} devolvió una respuesta vacía.`, 502);
      return { text, calls, parts: [...(text ? [{ text }] : []), ...calls.map(c => ({ functionCall: c }))], engine: o.name };
    },
    async transcribe() { throw new Error(`${o.name} no transcribe aquí: la escucha usa Groq Whisper o Gemini.`); }
  };
}
