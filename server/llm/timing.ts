import type { Llm } from './types.js';

export interface Timing { llmCalls: number; llmMs: number; engines: string[]; slowestMs: number; totalMs?: number }

/** Mide cuánto tarda el motor de IA en un turno (llamadas, tiempo total y la más lenta) sin cambiar su comportamiento. */
export function withTiming(llm: Llm): Llm & { stats(): Timing } {
  let calls = 0, ms = 0, slowest = 0;
  const engines: string[] = [];
  return {
    ...llm,
    async generate(req) {
      const t0 = Date.now();
      try {
        const r = await llm.generate(req);
        if (r.engine && !engines.includes(r.engine)) engines.push(r.engine);
        return r;
      } finally {
        const d = Date.now() - t0;
        calls++; ms += d; slowest = Math.max(slowest, d);
      }
    },
    transcribe: (a, m, s) => llm.transcribe(a, m, s),
    stats: () => ({ llmCalls: calls, llmMs: ms, engines: [...engines], slowestMs: slowest })
  };
}
