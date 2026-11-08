import { LlmHttpError, type EngineStatus, type Llm, type LlmRequest, type LlmResponse } from './types.js';

export interface Engine { name: string; model: string; llm: Llm; /** Puede transcribir audio. */ transcribes?: boolean }
export interface FailoverOpts {
  /** Tiempo máximo de cada intento antes de pasar al siguiente motor. 0 = sin límite. */
  attemptTimeoutMs: number;
  /** Cuánto se evita un motor tras fallar (se duplica con cada fallo seguido, hasta 10 min). */
  cooldownMs: number;
  now?: () => number;
  onSwitch?: (e: { from: string; to: string | null; error: string }) => void;
}

/** ¿El fallo es del motor (clave, cuota, caída, tiempo) y no de esta petición concreta? Solo entonces se le da un respiro. */
export function isEngineFault(e: unknown): boolean {
  const status = e instanceof LlmHttpError ? e.status : undefined;
  if (status === undefined) return true;                       // red, tiempo agotado, respuesta ilegible
  return [401, 402, 403, 404, 408, 425, 429].includes(status) || status >= 500;
}

interface State { failures: number; downUntil: number; lastError: string | null; lastOkAt: number | null; lastFailAt: number | null; answered: number }
const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
const brief = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 160);

/**
 * Rotación de motores de IA: prueba los motores en orden, pasa al siguiente en cuanto uno falla o tarda demasiado, y deja
 * a los que fallan en «enfriamiento» para no perder tiempo con ellos en las peticiones siguientes. Pasado el enfriamiento
 * se vuelve a probar el primero (si falla otra vez, el enfriamiento se duplica).
 * El estado vive en memoria de cada instancia del servidor: en Vercel cada instancia lo aprende por su cuenta.
 */
export function createFailover(engines: Engine[], opts: FailoverOpts): Llm {
  if (!engines.length) throw new Error('Se necesita al menos un motor de IA.');
  const now = opts.now ?? Date.now;
  const st = new Map<string, State>(engines.map(e => [e.name, { failures: 0, downUntil: 0, lastError: null, lastOkAt: null, lastFailAt: null, answered: 0 }]));

  const order = (): Engine[] => {
    const t = now();
    const healthy = engines.filter(e => st.get(e.name)!.downUntil <= t);
    // Si todos están en enfriamiento se prueban igualmente, el que se recupera antes primero: nunca se responde «nada» sin intentarlo.
    const cooling = engines.filter(e => st.get(e.name)!.downUntil > t).sort((a, b) => st.get(a.name)!.downUntil - st.get(b.name)!.downUntil);
    return [...healthy, ...cooling];
  };

  return {
    async generate(req: LlmRequest): Promise<LlmResponse> {
      const errors: string[] = [];
      const list = order();
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!;
        const s = st.get(e.name)!;
        // Límite de tiempo por intento (solo si hay a quién pasar). Temporizador normal, no AbortSignal.timeout: ese no mantiene vivo el proceso.
        const limit = opts.attemptTimeoutMs > 0 && list.length > 1;
        const timeout = new AbortController();
        const timer = limit ? setTimeout(() => timeout.abort(new Error('tiempo agotado')), opts.attemptTimeoutMs) : undefined;
        const signal = limit ? (req.signal ? AbortSignal.any([req.signal, timeout.signal]) : timeout.signal) : req.signal;
        try {
          const r = await e.llm.generate({ ...req, signal });
          s.failures = 0; s.downUntil = 0; s.lastOkAt = now(); s.answered++;
          return { ...r, engine: e.name };
        } catch (err) {
          if (req.signal?.aborted) throw err;                   // lo canceló quien llamó: no es culpa del motor
          const timedOut = timeout.signal.aborted;
          const msg = timedOut ? `sin respuesta en ${opts.attemptTimeoutMs} ms` : brief(err);
          errors.push(`${e.name}: ${msg}`);
          s.lastError = msg; s.lastFailAt = now();
          if (timedOut || isEngineFault(err)) {
            s.failures++;
            s.downUntil = now() + Math.min(opts.cooldownMs * 2 ** (s.failures - 1), 600_000);
          }
          opts.onSwitch?.({ from: e.name, to: list[i + 1]?.name ?? null, error: msg });
        } finally {
          clearTimeout(timer);
        }
      }
      throw new LlmHttpError(`Ningún motor de IA respondió (${errors.join(' · ')}).`, 503);
    },

    async transcribe(audio, mimeType, signal) {
      const e = engines.find(x => x.transcribes);
      if (!e) throw new Error('Ningún motor de IA configurado puede transcribir audio.');
      return e.llm.transcribe(audio, mimeType, signal);
    },

    status(): EngineStatus[] {
      const t = now();
      return engines.map(e => {
        const s = st.get(e.name)!;
        const cooling = s.downUntil > t;
        return { name: e.name, model: e.model, state: cooling ? 'enfriamiento' : 'ok', failures: s.failures, downUntil: cooling ? iso(s.downUntil) : null, lastError: s.lastError, lastOkAt: iso(s.lastOkAt), lastFailAt: iso(s.lastFailAt), answered: s.answered };
      });
    }
  };
}
