import type { Deps } from '../deps.js';
import type { FunctionDecl, Turn } from '../llm/types.js';
import { runSpecialist, SPECIALISTS, SECURITY_RULES, type SpecialistId, type SpecialistResult } from './specialists.js';
import { addMessage, getOrCreateConversation, listMessages } from './conversations.js';
import { getStyle } from '../memory/memory.js';
import { enqueue } from '../jobs/queue.js';
import type { Card } from '../actions/actions.js';
import { HttpError } from '../http/http.js';
import { composeMainPrompt } from './brain.js';
import type { OnEvent } from './events.js';
import { withTiming, type Timing } from '../llm/timing.js';
import { cleanReply } from './persona.js';
import { claimsDone, CLAIM_NUDGE, isEmptyPromise, PROMISE_NUDGE_MAIN } from './promises.js';
import { fastRoute } from './fastRoute.js';

const MAX_MAIN_STEPS = 4;
/** Delegaciones a especialistas por petición (ahorra cuota y evita bucles). */
const MAX_DELEGATIONS = 6;
const HISTORY = 12;
/** La respuesta se leerá en voz alta: se le pide al especialista (que no ve el modo del principal) que ya la dé corta. */
const VOICE_TASK_HINT = '\n\n(La respuesta se leerá en voz alta: 2 o 3 frases cortas, sin listas, sin markdown y sin identificadores.)';
/** En voz, un resultado más largo que esto lo condensa el principal en vez de leerse tal cual. */
const MAX_VOICE_DIRECT_CHARS = 450;
const isOff = (v: string | undefined) => v?.trim().toLowerCase() === 'off';

/**
 * El texto de un especialista, listo para decírselo al dueño tal cual (sin otra llamada al modelo para redactarlo), o null si
 * conviene que el principal lo redacte: resultado parcial, vacío, o demasiado largo para leerlo en voz alta.
 */
export function directReply(r: SpecialistResult, voice: boolean): string | null {
  const text = r.text.trim();
  if (r.partial || !text || (voice && text.length > MAX_VOICE_DIRECT_CHARS)) return null;
  const pending = r.cards.some(c => c.kind === 'confirm');
  return pending && !/tarjeta/i.test(text) ? `${text} Confírmalo en la tarjeta.` : text;   // el dueño tiene que saber dónde confirmar
}

const DELEGATE: FunctionDecl = {
  name: 'delegar',
  description: 'Encarga una tarea concreta a un especialista. Pasa en «tarea» todo lo que necesita saber (el especialista NO ve la conversación). Usa en_segundo_plano=true para tareas largas (reportes extensos, revisar muchos datos).',
  parameters: {
    type: 'object',
    properties: {
      especialista: { type: 'string', enum: Object.keys(SPECIALISTS) },
      tarea: { type: 'string', description: 'Instrucción autosuficiente para el especialista.' },
      en_segundo_plano: { type: 'boolean' }
    },
    required: ['especialista', 'tarea']
  }
};

export function mainSystemPrompt(style: { description: string; samples: string[] }, opts: { voice?: boolean } = {}): string {
  return composeMainPrompt({
    specialists: Object.entries(SPECIALISTS).map(([id, sp]) => `- ${id}: ${sp.description}${sp.availableFrom ? ` (disponible en la ${sp.availableFrom})` : ''}`).join('\n'),
    style,
    security: SECURITY_RULES,
    voice: opts.voice
  });
}

export interface TurnResult {
  conversationId: string;
  reply: string;
  cardIds: string[];
  jobIds: string[];
  partial: boolean;
  /** Dónde se fue el tiempo: llamadas al motor de IA y cuál respondió. */
  timing?: Timing;
}

/** Un turno de chat: guarda el mensaje, delega en especialistas y guarda la respuesta (con sus tarjetas). */
/** `voice`: la respuesta se leerá en voz alta (más corta). `onEvent`: progreso en vivo (qué hemisferio trabaja). */
export async function runTurn(deps: Deps, p: { userId: string; conversationId: string | null; message: string; voice?: boolean; onEvent?: OnEvent }): Promise<TurnResult> {
  const message = p.message.trim();
  if (!message) throw new HttpError(400, 'El mensaje está vacío.');
  const conv = await getOrCreateConversation(deps.db, p.userId, p.conversationId, message);
  const history = await listMessages(deps.db, p.userId, conv.id, HISTORY);
  await addMessage(deps.db, p.userId, conv.id, 'user', message);

  if (!deps.llm) {
    const reply = 'Falta configurar un motor de IA (la clave de al menos un motor: GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY o CEREBRAS_API_KEY) en las variables del servidor. Mientras tanto puedes revisar los paneles y los conectores.';
    await addMessage(deps.db, p.userId, conv.id, 'assistant', reply);
    return { conversationId: conv.id, reply, cardIds: [], jobIds: [], partial: false };
  }

  const start = Date.now();
  const budgetMs = deps.cfg.limits.turnBudgetMs;
  const safety = Math.min(2000, budgetMs / 5);
  // Plazo duro de TODO el turno: una llamada colgada del motor ya no se queda hasta que Vercel mata la función (60 s).
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), Math.max(1, budgetMs - safety));
  const timed = withTiming(deps.llm);
  const d: Deps = { ...deps, llm: timed };
  const turns: Turn[] = history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
  while (turns[0]?.role === 'model') turns.shift(); // el historial debe empezar con el usuario
  turns.push({ role: 'user', parts: [{ text: message }] });
  const system = mainSystemPrompt(await getStyle(deps.db, p.userId), { voice: p.voice });
  p.onEvent?.({ tipo: 'pensando' });
  const cards: Card[] = [];
  const jobIds: string[] = [];
  let reply = '';
  let partial = false;
  let delegations = 0;
  /** Por qué camino salió la respuesta: «rapida» (directo al especialista), «directa» (sin que el principal la redacte) o «completa». */
  let via: 'rapida' | 'directa' | 'completa' = 'completa';
  /** ¿Se ejecutó ya alguna delegación en este turno? Sin ella, una promesa o un «ya lo hice» son falsos. */
  let toolWork = false;
  let nudged = false;
  const env = deps.cfg.env;
  const voiceHint = p.voice ? VOICE_TASK_HINT : '';

  try {
    // Consulta clara de solo lectura: directo al especialista, sin gastar una llamada del principal en decidir a quién delegar.
    const route = isOff(env.FAST_ROUTE) ? null : fastRoute(message);
    if (route) {
      const left = budgetMs - (Date.now() - start) - safety - 1000;
      const r = await runSpecialist(d, { userId: p.userId, conversationId: conv.id, specialist: route.specialist, task: route.task + voiceHint, deadlineMs: Math.min(deps.cfg.limits.specialistDeadlineMs, left), onEvent: p.onEvent });
      cards.push(...r.cards);
      toolWork = true;
      const direct = directReply(r, !!p.voice);
      if (direct) { reply = direct; via = 'rapida'; delegations = 1; }   // si no salió bien, sigue el camino completo
    }

    for (let step = 0; step < MAX_MAIN_STEPS && via !== 'rapida'; step++) {
      const remaining = budgetMs - (Date.now() - start);
      if (remaining < Math.min(4000, budgetMs / 5)) { partial = true; break; }
      const last = step === MAX_MAIN_STEPS - 1;
      let resp;
      try {
        resp = await d.llm!.generate({ system, turns, tools: last ? undefined : [DELEGATE], signal: budget.signal });
      } catch (e) {
        if (budget.signal.aborted) { partial = true; break; }   // se acabó el tiempo del turno: se responde con lo que haya
        throw e;
      }
      turns.push({ role: 'model', parts: resp.parts.length ? resp.parts : [{ text: resp.text || '…' }] });
      if (!resp.calls.length) {
        // Promete («ahora mismo lo reviso») o da por hecho («ya lo creé») sin haber delegado nada: el dueño se quedaría esperando
        // algo que nadie va a hacer. Se le avisa al modelo una sola vez.
        const promise = isEmptyPromise(resp.text);
        if (!toolWork && !nudged && !last && (promise || claimsDone(resp.text))) {
          nudged = true;
          turns.push({ role: 'user', parts: [{ text: promise ? PROMISE_NUDGE_MAIN : CLAIM_NUDGE }] });
          continue;
        }
        reply = resp.text; break;
      }
      toolWork = true;

      // Las delegaciones de un mismo paso son independientes: van en paralelo (el orden de las respuestas se conserva).
      const results = await Promise.all(resp.calls.map(async call => {
        const sp = String(call.args.especialista ?? '') as SpecialistId;
        const task = String(call.args.tarea ?? '').slice(0, 4000);
        let response: Record<string, unknown>;
        let result: SpecialistResult | undefined;
        if (++delegations > MAX_DELEGATIONS) {
          response = { error: `Tope de ${MAX_DELEGATIONS} delegaciones por petición alcanzado: responde con lo que ya tienes.` };
        } else if (call.name !== 'delegar' || !(sp in SPECIALISTS) || !task) {
          response = { error: 'Llamada inválida: usa delegar(especialista, tarea).' };
        } else if (call.args.en_segundo_plano === true) {
          const job = await enqueue(deps.db, { userId: p.userId, conversationId: conv.id, kind: 'especialista', title: task.slice(0, 80), payload: { especialista: sp, tarea: task } });
          jobIds.push(job.id);
          response = { estado: 'en_segundo_plano', trabajo: job.id, mensaje: 'La tarea quedó en «Trabajos»; el resultado llegará a esta conversación.' };
        } else {
          const left = budgetMs - (Date.now() - start) - safety - 1000;
          const r = await runSpecialist(d, { userId: p.userId, conversationId: conv.id, specialist: sp, task: task + voiceHint, deadlineMs: Math.min(deps.cfg.limits.specialistDeadlineMs, left), onEvent: p.onEvent });
          cards.push(...r.cards);
          partial ||= r.partial;
          result = r;
          response = {
            resultado: r.text, parcial: r.partial,
            tarjetas: r.cards.map(c => ({ id: c.id, tipo: c.kind === 'confirm' ? 'pendiente_de_confirmacion' : 'hecho_con_opcion_de_deshacer', resumen: c.summary })),
            no_disponibles: r.unavailable.map(u => `${u.title}: ${u.state}`)
          };
        }
        return { name: call.name, response, result };
      }));
      turns.push({ role: 'user', parts: results.map(x => ({ functionResponse: { name: x.name, response: x.response } })) });

      // Una sola delegación que salió bien: su resultado ya es la respuesta; no se gasta otra llamada para volver a redactarlo.
      const only = results.length === 1 ? results[0]!.result : undefined;
      const direct = only && !isOff(env.PASS_THROUGH) && !last ? directReply(only, !!p.voice) : null;
      if (direct) { reply = direct; via = 'directa'; break; }
    }
  } finally {
    clearTimeout(budgetTimer);
  }

  const st = timed.stats();
  // Ningún motor llegó a responder: decirlo claro (con el motivo) en vez del genérico «no alcancé a terminar».
  const noEngine = partial && !reply && st.ok === 0;
  if (noEngine) {
    const engines = deps.llm.status?.() ?? [];
    const why = st.lastError ?? engines.find(e => e.lastError)?.lastError ?? 'sin respuesta';
    reply = `El motor de IA no respondió a tiempo (${why}). Suele ser sobrecarga o un modelo mal configurado: revisa los modelos (GEMINI_MODEL, GROQ_MODEL…) o añade la clave de otro motor (CEREBRAS_API_KEY, OPENROUTER_API_KEY). Inténtalo de nuevo en un momento.`;
  }
  reply = cleanReply(reply);
  // Sin respuesta no se inventa un «Listo.»: se dice lo que de verdad pasó.
  if (!reply) {
    reply = partial ? 'No alcancé a terminar todo dentro del tiempo de esta petición. Lo que quedó pendiente puedes pedírmelo de nuevo o en segundo plano.'
      : cards.some(c => c.kind === 'confirm') ? 'Dejé preparadas las acciones en las tarjetas; confírmalas cuando quieras.'
      : 'No obtuve una respuesta del modelo, así que no hice nada. Inténtalo de nuevo en un momento.';
  }
  if (jobIds.length) deps.defer(import('../jobs/tick.js').then(m => m.runTick(deps)));
  await addMessage(deps.db, p.userId, conv.id, 'assistant', reply, cards.map(c => c.id));
  const timing = { ...timed.stats(), totalMs: Date.now() - start, via };
  console.log('turno', JSON.stringify(timing));   // queda en los registros de Vercel: ahí se ve dónde se fue el tiempo
  return { conversationId: conv.id, reply, cardIds: cards.map(c => c.id), jobIds, partial, timing };
}
