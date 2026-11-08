import { LlmHttpError, type Llm, type LlmRequest, type LlmResponse, type Part } from './types.js';

export const GEMINI_ENV = ['GEMINI_API_KEY', 'GEMINI_MODEL'] as const;

interface GeminiOpts { apiKey: string; model: string; baseUrl: string; fetch: typeof fetch; /** Tokens de «pensar» (0 = sin pensar, más rápido). Solo se envía si se configura. */ thinkingBudget?: number }

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

export function createGemini(o: GeminiOpts): Llm {
  return {
    async generate(req: LlmRequest): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.turns,
        generationConfig: { temperature: 0.4, ...(o.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: o.thinkingBudget } } : {}) }
      };
      if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools }];
      let resp: Record<string, unknown>;
      try { resp = await geminiGenerate(o, o.model, body, req.signal); }
      catch (e) {
        // Algunos modelos no admiten apagar el «pensar»: se reintenta una vez sin ese ajuste.
        if (o.thinkingBudget !== undefined && e instanceof LlmHttpError && e.status === 400 && /think/i.test(e.message)) {
          body.generationConfig = { temperature: 0.4 };
          resp = await geminiGenerate(o, o.model, body, req.signal);
        } else throw e;
      }
      const parts = partsOf(resp);
      const text = parts.map(p => ('text' in p ? p.text : '')).join('').trim();
      const calls = parts.flatMap(p => ('functionCall' in p ? [{ name: p.functionCall.name, args: p.functionCall.args ?? {} }] : []));
      return { text, calls, parts };
    },
    async transcribe(audio, mimeType, signal) {
      const body = {
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType, data: audio.toString('base64') } },
          { text: 'Transcribe literalmente este audio en español. Devuelve solo el texto transcrito, sin comentarios. Si no hay voz, devuelve una cadena vacía.' }
        ] }],
        generationConfig: { temperature: 0 }
      };
      const parts = partsOf(await geminiGenerate(o, o.model, body, signal));
      return parts.map(p => ('text' in p ? p.text : '')).join('').trim();
    }
  };
}
