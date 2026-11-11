import type { Llm } from './types.js';

export interface Timing { llmCalls: number; /** Llamadas que sí devolvieron respuesta. */ ok: number; llmMs: number; engines: string[]; slowestMs: number; /** Último fallo de un motor en este turno (para el registro). */ lastError?: string; totalMs?: number; /** Camino del turno: «rapida» (directo al especialista), «directa» (el principal no vuelve a redactar) o «completa». */ via?: string }

/** Mide cuánto tarda el motor de IA en un turno (llamadas, tiempo total y la más lenta) sin cambiar su comportamiento. */
export function withTiming(llm: Llm): Llm & { stats(): Timing } {
  let calls = 0, ok = 0, ms = 0, slowest = 0;
  let lastError: string | undefined;
  const engines: string[] = [];
  return {
    ...llm,
    async generate(req) {
      const t0 = Date.now();
      try {
        const r = await llm.generate(req);
        ok++;
        if (r.engine && !engines.includes(r.engine)) engines.push(r.engine);
        return r;
      } catch (e) {
        lastError = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);
        throw e;
      } finally {
        const d = Date.now() - t0;
        calls++; ms += d; slowest = Math.max(slowest, d);
      }
    },
    transcribe: (a, m, s) => llm.transcribe(a, m, s),
    stats: () => ({ llmCalls: calls, ok, llmMs: ms, engines: [...engines], slowestMs: slowest, ...(lastError ? { lastError } : {}) })
  };
}
