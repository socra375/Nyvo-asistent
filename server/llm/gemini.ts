import { LlmHttpError, type Llm, type LlmRequest, type LlmResponse, type Part } from './types.js';

export const GEMINI_ENV = ['GEMINI_API_KEY', 'GEMINI_MODEL'] as const;

interface GeminiOpts {
  apiKey: string; model: string; baseUrl: string; fetch: typeof fetch;
  /** Tokens de «pensar» (0 = sin pensar, más rápido). Fijo: solo se envía si se configura. */
  thinkingBudget?: number;
  /** Sin presupuesto fijo, baja solo por la escalera de «pensar» (ver LADDER). Solo para modelos Flash. */
  thinkingAuto?: boolean;
  /** Tope de tokens de salida (cuentan también los de «pensar»). */
  maxOutputTokens?: number;
}

/**
 * Los modelos Flash «-latest» piensan antes de responder y esos segundos invisibles (y su cuota) son lo más caro de una
 * conversación por voz. Se pide lo mínimo que admita el modelo: `thinkingBudget: 0` en Gemini 2.5 y `thinkingLevel: «minimal»`
 * en Gemini 3. El campo que vale cambia entre las versiones que hay detrás de un alias «-latest» y uno equivocado da 400, así
 * que cada modelo baja por esta escalera la primera vez que se lo rechazan y recuerda dónde se quedó (mientras viva la instancia).
 */
const LADDER: (Record<string, unknown> | null)[] = [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, null];
const position = new Map<string, number>();
const ladderConfig = (model: string) => LADDER[position.get(model) ?? 0] ?? null;
function nextThinking(model: string): boolean {
  const at = position.get(model) ?? 0;
  if (at >= LADDER.length - 1 || !LADDER[at]) return false;
  position.set(model, at + 1);
  return true;
}
export const resetThinking = () => position.clear();
const DEFAULT_MAX_OUTPUT = 8192;

/** Llamada REST a generateContent. La clave va en la cabecera x-goog-api-key, nunca en la URL. */
export async function geminiGenerate(o: GeminiOpts, model: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const url = `${o.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const r = await o.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.apiKey },
    body: JSON.stringify(body),
    signal
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new LlmHttpError(`Gemini respondió ${r.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, r.status);
  }
  return await r.json() as Record<string, unknown>;
}

function partsOf(resp: Record<string, unknown>): Part[] {
  const cands = resp.candidates as { content?: { parts?: Part[] } }[] | undefined;
  return cands?.[0]?.content?.parts ?? [];
}

/** Por qué Gemini no contestó nada (bloqueo del texto o motivo de fin), para el mensaje de error. */
function emptyReason(resp: Record<string, unknown>): string {
  const block = (resp.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
  const finish = (resp.candidates as { finishReason?: string }[] | undefined)?.[0]?.finishReason;
  return block ? `bloqueo «${block}»` : finish ? `motivo «${finish}»` : 'sin motivo';
}

const rejectsThinking = (e: unknown) => e instanceof LlmHttpError && e.status === 400 && /think|invalid argument|unknown name/i.test(e.message);

/** generateContent con el ajuste de «pensar»: fijo si se configuró, o bajando por la escalera cuando el modelo rechaza el campo. */
async function generateWithThinking(o: GeminiOpts, body: Record<string, unknown> & { generationConfig: Record<string, unknown> }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let dropFixed = false;
  for (;;) {
    const thinking = o.thinkingAuto ? ladderConfig(o.model) : o.thinkingBudget !== undefined && !dropFixed ? { thinkingBudget: o.thinkingBudget } : null;
    if (thinking) body.generationConfig.thinkingConfig = thinking; else delete body.generationConfig.thinkingConfig;
    try { return await geminiGenerate(o, o.model, body, signal); }
    catch (e) {
      if (!thinking || !rejectsThinking(e)) throw e;
      if (o.thinkingAuto) { if (!nextThinking(o.model)) throw e; }    // el siguiente ajuste de la escalera
      else dropFixed = true;                                           // el modelo no admite el valor fijado: una vez más sin él
    }
  }
}

export function createGemini(o: GeminiOpts): Llm {
  return {
    async generate(req: LlmRequest): Promise<LlmResponse> {
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.turns,
        generationConfig: { temperature: 0.4, maxOutputTokens: o.maxOutputTokens ?? DEFAULT_MAX_OUTPUT } as Record<string, unknown>,
        ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools }] } : {})
      };
      const resp = await generateWithThinking(o, body, req.signal);
      const parts = partsOf(resp);
      const text = parts.map(p => ('text' in p ? p.text : '')).join('').trim();
      const calls = parts.flatMap(p => ('functionCall' in p ? [{ name: p.functionCall.name, args: p.functionCall.args ?? {} }] : []));
      // Una respuesta vacía (texto bloqueado, o el tope de tokens gastado en «pensar») no es una respuesta: se prueba otro motor.
      // 422 = fallo de esta petición, no del motor: no lo deja en enfriamiento.
      if (!text && !calls.length) throw new LlmHttpError(`Gemini devolvió una respuesta vacía (${emptyReason(resp)}).`, 422);
      return { text, calls, parts };
    },
    async transcribe(audio, mimeType, signal) {
      const body = {
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType, data: audio.toString('base64') } },
          { text: 'Transcribe literalmente este audio en español. Devuelve solo el texto transcrito, sin comentarios. Si no hay voz, devuelve una cadena vacía.' }
        ] }],
        generationConfig: { temperature: 0 } as Record<string, unknown>
      };
      const parts = partsOf(await generateWithThinking(o, body, signal));
      return parts.map(p => ('text' in p ? p.text : '')).join('').trim();
    }
  };
}
