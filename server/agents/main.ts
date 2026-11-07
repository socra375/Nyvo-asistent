import type { Deps } from '../deps.js';
import type { FunctionDecl, Turn } from '../llm/types.js';
import { runSpecialist, SPECIALISTS, SECURITY_RULES, type SpecialistId } from './specialists.js';
import { addMessage, getOrCreateConversation, listMessages } from './conversations.js';
import { getStyle } from '../memory/memory.js';
import { enqueue } from '../jobs/queue.js';
import type { Card } from '../actions/actions.js';
import { HttpError } from '../http/http.js';
import { composeMainPrompt } from './brain.js';
import type { OnEvent } from './events.js';

/** Plazo total de una respuesta de chat: deja margen bajo el corte de 60 s de Vercel. */
export const TURN_BUDGET_MS = 50_000;
const MAX_MAIN_STEPS = 4;
const HISTORY = 12;

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
    const reply = 'Falta configurar Gemini (GEMINI_API_KEY y GEMINI_MODEL) en las variables del servidor. Mientras tanto puedes revisar los paneles y los conectores.';
    await addMessage(deps.db, p.userId, conv.id, 'assistant', reply);
    return { conversationId: conv.id, reply, cardIds: [], jobIds: [], partial: false };
  }

  const start = Date.now();
  const turns: Turn[] = history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
  while (turns[0]?.role === 'model') turns.shift(); // el historial debe empezar con el usuario
  turns.push({ role: 'user', parts: [{ text: message }] });
  const system = mainSystemPrompt(await getStyle(deps.db, p.userId), { voice: p.voice });
  p.onEvent?.({ tipo: 'pensando' });
  const cards: Card[] = [];
  const jobIds: string[] = [];
  let reply = '';
  let partial = false;

  for (let step = 0; step < MAX_MAIN_STEPS; step++) {
    const remaining = TURN_BUDGET_MS - (Date.now() - start);
    if (remaining < 4000) { partial = true; break; }
    const last = step === MAX_MAIN_STEPS - 1;
    const resp = await deps.llm.generate({ system, turns, tools: last ? undefined : [DELEGATE] });
    turns.push({ role: 'model', parts: resp.parts.length ? resp.parts : [{ text: resp.text || '…' }] });
    if (!resp.calls.length) { reply = resp.text; break; }

    const responses = [];
    for (const call of resp.calls) {
      const sp = String(call.args.especialista ?? '') as SpecialistId;
      const task = String(call.args.tarea ?? '').slice(0, 4000);
      let response: Record<string, unknown>;
      if (call.name !== 'delegar' || !(sp in SPECIALISTS) || !task) {
        response = { error: 'Llamada inválida: usa delegar(especialista, tarea).' };
      } else if (call.args.en_segundo_plano === true) {
        const job = await enqueue(deps.db, { userId: p.userId, conversationId: conv.id, kind: 'especialista', title: task.slice(0, 80), payload: { especialista: sp, tarea: task } });
        jobIds.push(job.id);
        response = { estado: 'en_segundo_plano', trabajo: job.id, mensaje: 'La tarea quedó en «Trabajos»; el resultado llegará a esta conversación.' };
      } else {
        const left = TURN_BUDGET_MS - (Date.now() - start) - 3000;
        const r = await runSpecialist(deps, { userId: p.userId, conversationId: conv.id, specialist: sp, task, deadlineMs: Math.min(deps.cfg.limits.specialistDeadlineMs, left), onEvent: p.onEvent });
        cards.push(...r.cards);
        partial ||= r.partial;
        response = {
          resultado: r.text, parcial: r.partial,
          tarjetas: r.cards.map(c => ({ id: c.id, tipo: c.kind === 'confirm' ? 'pendiente_de_confirmacion' : 'hecho_con_opcion_de_deshacer', resumen: c.summary })),
          no_disponibles: r.unavailable.map(u => `${u.title}: ${u.state}`)
        };
      }
      responses.push({ functionResponse: { name: call.name, response } });
    }
    turns.push({ role: 'user', parts: responses });
  }

  if (!reply) reply = partial ? 'No alcancé a terminar todo dentro del tiempo de esta petición. Lo que quedó pendiente puedes pedírmelo de nuevo o en segundo plano.' : 'Listo.';
  if (jobIds.length) deps.defer(import('../jobs/tick.js').then(m => m.runTick(deps)));
  await addMessage(deps.db, p.userId, conv.id, 'assistant', reply, cards.map(c => c.id));
  return { conversationId: conv.id, reply, cardIds: cards.map(c => c.id), jobIds, partial };
}
