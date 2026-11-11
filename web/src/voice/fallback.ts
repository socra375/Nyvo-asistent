/**
 * Voz de respaldo: si el proveedor de voz del servidor falla (cuota, caída, red), esa frase se lee con la voz del navegador
 * en vez de quedarse mudo. Cuando el fallo es del proveedor (no de la frase), se deja de insistir un rato para no perder un
 * viaje al servidor por cada frase de la respuesta y para no mezclar dos voces. Genérica y sin navegador para poder probarla.
 */
export interface FallbackOpts<A, B> {
  primary: (text: string, signal: AbortSignal) => Promise<A>;
  fallback: (text: string, signal: AbortSignal) => Promise<B>;
  /** Cuánto se evita el proveedor tras un fallo suyo. */
  cooldownMs: number;
  /** ¿Es un fallo del proveedor (y no de esta frase)? Solo entonces se abre el enfriamiento. Por defecto, siempre. */
  isProviderFault?: (error: unknown) => boolean;
  onFallback?: (reason: string) => void;
  now?: () => number;
}

export type Voiced<A, B> = { from: 'primary'; value: A } | { from: 'fallback'; value: B };

export function createFallback<A, B>(o: FallbackOpts<A, B>): (text: string, signal: AbortSignal) => Promise<Voiced<A, B>> {
  const now = o.now ?? Date.now;
  let until = 0;
  return async (text, signal) => {
    if (now() < until) return { from: 'fallback', value: await o.fallback(text, signal) };
    try { return { from: 'primary', value: await o.primary(text, signal) }; }
    catch (e) {
      if (signal.aborted) throw e;                     // lo cortó el usuario (interrupción): no es un fallo del proveedor
      if (o.isProviderFault?.(e) ?? true) until = now() + o.cooldownMs;
      o.onFallback?.(e instanceof Error ? e.message : String(e));
      return { from: 'fallback', value: await o.fallback(text, signal) };
    }
  };
}

/** Los fallos del proveedor de voz (cuota, clave, caída, red) abren el enfriamiento; uno de la frase (400, 413…) no. */
export function isVoiceProviderFault(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status === 429 || status >= 500 || status === 401 || status === 402 || status === 403 || status === 404;
}
