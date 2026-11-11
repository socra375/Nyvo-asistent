// Menos peticiones por día, menos espera y ninguna respuesta falsa: consultas claras que van directo al especialista, la respuesta
// del especialista sin que el principal la redacte otra vez, delegaciones en paralelo, y los avisos contra «ahora mismo lo hago» /
// «ya lo creé» cuando no se llamó a ninguna herramienta. Modelo guionizado y servidores falsos: sin red ni claves.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeAllDbs, type Db } from '../../server/db/pool.js';
import { claimsDone, CLAIM_NUDGE, isEmptyPromise, PROMISE_NUDGE_MAIN, PROMISE_NUDGE_SPECIALIST } from '../../server/agents/promises.js';
import { fastRoute, MAX_FAST_CHARS } from '../../server/agents/fastRoute.js';
import { directReply, runTurn } from '../../server/agents/main.js';
import { runSpecialist, type SpecialistResult } from '../../server/agents/specialists.js';
import type { TurnEvent } from '../../server/agents/events.js';
import type { Card } from '../../server/actions/actions.js';
import type { LlmRequest } from '../../server/llm/types.js';
import { freshDb, makeDeps, makeUser, needsDb, scriptedLlm } from '../helpers.js';
import { initialState, startUpstream, upstreamEnv, type Upstream } from '../fakes/upstream.js';

describe('promesas y «ya lo hice» sin haber hecho nada', () => {
  test('promesas vacías: se reconocen (con y sin tildes) y una pregunta o una respuesta larga no lo son', () => {
    for (const t of ['Ahora mismo reviso tus clientes.', 'Voy a revisar tus cobros.', 'Estoy consultando tu agenda.', 'Un momento, lo busco.', 'Déjame revisar eso.', 'Dame un segundo.', 'Procedo a crear el cobro.', 'En un momento te lo preparo.', 'AHORA MISMO LO ENVÍO']) assert.ok(isEmptyPromise(t), t);
    for (const t of ['Tienes 2 clientes activos: Laura Méndez y Pedro Ruiz.', '¿Quieres que lo revise ahora mismo?', 'Hola, soy Nyvo. ¿En qué te ayudo?', 'El cobro de Café Brisa sigue pendiente.', '', 'Voy a ser claro: no tengo acceso a eso.'.repeat(40)]) assert.ok(!isEmptyPromise(t), t.slice(0, 40));
  });

  test('«ya lo hice» sin haberlo hecho: se reconoce; contar lo que hay en los datos no lo es', () => {
    for (const t of ['Listo, ya envié el correo a Laura.', 'Ya lo creé.', 'He registrado el cobro.', 'Quedó guardado en Notion.', 'Hecho, ya lo marqué como pagado.', 'Ya se lo mandé a tu cliente.']) assert.ok(claimsDone(t), t);
    for (const t of ['Tienes 2 clientes activos.', 'Laura envió un correo ayer y Pedro creó un proyecto nuevo.', '¿Ya lo enviaste tú?', 'Todavía no lo he enviado.', 'Puedo enviarlo cuando me lo pidas.', 'No pude crear el cobro.', 'Aún no se ha enviado nada, ni lo he guardado.', '']) assert.ok(!claimsDone(t), t);
  });
});

describe('consultas claras de solo lectura (ruta rápida)', () => {
  test('van directo al especialista que corresponde y llevan el mensaje tal cual', () => {
    for (const m of ['¿Qué clientes tengo?', 'Dame los clientes activos', '¿Hay cobros pendientes?', 'Lista mis proyectos', 'Muéstrame las facturas de noviembre', '¿Cuántos clientes tengo?', 'Busca a Laura Méndez en mis clientes', '¿Qué conversaciones hay con clientes?', 'dime qué servicios tengo']) {
      const r = fastRoute(m);
      assert.equal(r?.specialist, 'negocios', m);
      assert.equal(r?.task, m);
    }
    for (const m of ['Lista los archivos principales de Drive', '¿Qué hay en mi drive?']) assert.equal(fastRoute(m)?.specialist, 'documentos', m);
  });

  test('ante cualquier duda sigue el camino completo: cambia datos, pide redactar o resumir, o depende de lo dicho antes', () => {
    for (const m of [
      'Marca como pagado el cobro de Café Brisa', 'Crea un cliente nuevo', 'Responde al cliente que escribió', 'Envíale un correo a los clientes', 'Anota que Laura prefiere las tardes',
      'Haz un reporte de cobros', 'Resume los cobros de este mes', 'Dame un informe de clientes', 'Redacta un correo para mis clientes', 'Guarda esto en Notion',
      '¿Qué cobros tiene?', 'Y los de Pedro, ¿qué clientes tengo?', 'También dame los proyectos', 'Ahora los cobros', 'Los mismos clientes de antes',
      'hola', 'gracias', '¿Quién eres?', 'Clientes', '¿Qué tiempo hace?', 'Qué debería hacer con mis clientes', 'Recomiéndame qué cobros priorizar',
      `Lista ${'clientes '.repeat(30)}`
    ]) assert.equal(fastRoute(m), null, m);
    assert.ok(MAX_FAST_CHARS <= 200);
  });
});

describe('directReply: cuándo el resultado del especialista ya es la respuesta', () => {
  const res = (over: Partial<SpecialistResult> = {}): SpecialistResult => ({ text: 'Tienes 2 clientes: Laura y Pedro.', cards: [], calls: 1, partial: false, unavailable: [], ...over });
  const card = { kind: 'confirm' } as unknown as Card;
  test('sí cuando salió bien; no si es parcial, vacío, o largo para leerlo en voz alta', () => {
    assert.equal(directReply(res(), false), 'Tienes 2 clientes: Laura y Pedro.');
    assert.equal(directReply(res({ partial: true }), false), null);
    assert.equal(directReply(res({ text: '  ' }), false), null);
    assert.equal(directReply(res({ text: 'x'.repeat(451) }), true), null, 'en voz lo condensa el principal');
    assert.equal(directReply(res({ text: 'x'.repeat(451) }), false), 'x'.repeat(451), 'por escrito puede ser largo');
  });
  test('con una acción pendiente de confirmar, lo dice (sin repetirlo si el texto ya lo dice)', () => {
    assert.equal(directReply(res({ text: 'Preparé el cobro.', cards: [card] }), false), 'Preparé el cobro. Confírmalo en la tarjeta.');
    assert.equal(directReply(res({ text: 'Preparé el cobro; confirma en la tarjeta.', cards: [card] }), false), 'Preparé el cobro; confirma en la tarjeta.');
    assert.equal(directReply(res({ text: 'Queda pendiente de tu confirmación.', cards: [card] }), false), 'Queda pendiente de tu confirmación. Confírmalo en la tarjeta.', 'decir «confirmación» no dice dónde confirmar');
  });
});

describe('el turno de punta a punta', needsDb, () => {
  let db: Db; let userId: string; let up: Upstream; let env: Record<string, string>;
  before(async () => { db = await freshDb(); userId = await makeUser(db); up = await startUpstream(); env = upstreamEnv(up.url, up.state); });
  after(async () => { await up.close(); await closeAllDbs(); });
  const reset = () => { Object.assign(up.state, initialState()); env.NOTION_ROOT_PAGE_ID = up.state.notionRoot; };
  const noConnectors = {};   // sin conectores el especialista no tiene herramientas y contesta con texto
  const isMain = (r: LlmRequest) => !!r.tools?.some(t => t.name === 'delegar');
  const lastUserText = (r: LlmRequest) => r.turns.filter(t => t.role === 'user').flatMap(t => t.parts.map(p => ('text' in p ? p.text : ''))).filter(Boolean).pop() ?? '';
  const delegate = (tarea = 'x', especialista = 'negocios') => ({ calls: [{ name: 'delegar', args: { especialista, tarea } }] });

  test('consulta clara: 2 llamadas (herramienta y resultado), sin pasar por el principal, con sus eventos de progreso', async () => {
    reset();
    const events: TurnEvent[] = [];
    const llm = scriptedLlm((_r, i) => i === 0 ? { calls: [{ name: 'ainova__search_clients', args: {} }] } : { text: 'Tienes 2 clientes: Laura y Pedro.' });
    const r = await runTurn(makeDeps(db, env, { llm }), { userId, conversationId: null, message: '¿Qué clientes tengo?', onEvent: e => events.push(e) });
    assert.equal(r.reply, 'Tienes 2 clientes: Laura y Pedro.');
    assert.equal(r.timing!.llmCalls, 2); assert.equal(r.timing!.via, 'rapida');
    assert.ok(!llm.requests.some(isMain), 'el principal ni se llamó');
    assert.equal(events[0]?.tipo, 'pensando');
    assert.deepEqual(events.filter(e => e.tipo === 'hemisferio').map(e => e.tipo === 'hemisferio' && [e.id, e.estado]), [['johan', 'activo'], ['johan', 'listo']]);
  });

  test('en voz, el especialista ya recibe la petición de responder corto', async () => {
    reset();
    const llm = scriptedLlm(() => ({ text: 'Tienes dos clientes.' }));
    await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: '¿Qué clientes tengo?', voice: true });
    assert.match(lastUserText(llm.requests[0]!), /se leerá en voz alta/);
    const written = scriptedLlm(() => ({ text: 'Dos.' }));
    await runTurn(makeDeps(db, noConnectors, { llm: written }), { userId, conversationId: null, message: '¿Qué clientes tengo?' });
    assert.doesNotMatch(lastUserText(written.requests[0]!), /voz alta/);
  });

  test('si la consulta rápida no sale bien (resultado largo en voz), el principal la redacta', async () => {
    reset();
    const llm = scriptedLlm(req => isMain(req) ? { text: 'Tienes dos clientes: Laura y Pedro.' } : { text: 'Muy largo. '.repeat(80) });
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: '¿Qué clientes tengo?', voice: true });
    assert.equal(r.reply, 'Tienes dos clientes: Laura y Pedro.');
    assert.equal(r.timing!.via, 'completa');
  });

  test('promesa vacía del principal: se le avisa una vez, delega de verdad y el dueño recibe el resultado', async () => {
    reset();
    const llm = scriptedLlm(req => {
      if (!isMain(req)) return { text: 'Tienes dos clientes.' };
      if (lastUserText(req).startsWith('[Aviso del sistema')) return delegate('Cuenta los clientes');
      return { text: 'Ahora mismo reviso tus clientes.' };
    });
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'Necesito saber cómo van mis clientes' });
    assert.equal(r.reply, 'Tienes dos clientes.');
    assert.equal(llm.requests.filter(q => isMain(q) && lastUserText(q) === PROMISE_NUDGE_MAIN).length, 1);
    assert.equal(r.timing!.llmCalls, 3);
  });

  test('«ya lo envié» sin haber delegado nada: se le avisa y la respuesta final es la sincera, no la falsa', async () => {
    reset();
    const llm = scriptedLlm(req => lastUserText(req) === CLAIM_NUDGE ? { text: 'Todavía no lo he enviado. ¿Quieres que prepare el correo para que lo confirmes?' } : { text: 'Listo, ya envié el correo a Laura.' });
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'Necesito avisarle a Laura del retraso' });
    assert.match(r.reply, /Todavía no lo he enviado/);
    assert.doesNotMatch(r.reply, /ya envié/);
    assert.equal(r.timing!.llmCalls, 2);
  });

  test('el aviso es uno solo por turno: si el modelo insiste no hay bucle ni más llamadas', async () => {
    reset();
    const llm = scriptedLlm(() => ({ text: 'Ahora mismo lo hago.' }));
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'Necesito avisarle a Laura del retraso' });
    assert.equal(llm.requests.length, 2);
    assert.equal(r.reply, 'Ahora mismo lo hago.');
  });

  test('sin falsa alarma: una pregunta, un saludo o una respuesta tras delegar no reciben aviso', async () => {
    reset();
    for (const text of ['¿Quieres que lo revise ahora mismo?', 'Hola, soy Nyvo. ¿En qué te ayudo con tus negocios?']) {
      const llm = scriptedLlm(() => ({ text }));
      const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'hola' });
      assert.equal(llm.requests.length, 1); assert.equal(r.reply, text);
    }
    // Después de delegar, «ya lo creé» es verdad (hay un resultado detrás): el principal no se cuestiona.
    const llm = scriptedLlm(req => isMain(req) ? (req.turns.length > 1 ? { text: 'Ya lo creé.' } : delegate('Crea el cobro')) : { text: 'Hecho.'.repeat(1) + ' x'.repeat(260) });
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'Necesito cobrarle a Laura' });
    assert.ok(!llm.requests.some(q => lastUserText(q).startsWith('[Aviso del sistema')));
    assert.ok(r.reply.length > 0);
  });

  test('sin respuesta del modelo no se inventa un «Listo.»', async () => {
    reset();
    const r = await runTurn(makeDeps(db, noConnectors, { llm: scriptedLlm(() => ({ text: '' })) }), { userId, conversationId: null, message: 'hola' });
    assert.doesNotMatch(r.reply, /^Listo\.?$/);
    assert.match(r.reply, /No obtuve una respuesta del modelo.*no hice nada/);
  });

  test('un especialista que promete sin usar su herramienta recibe el aviso y la usa', async () => {
    reset();
    const afterTool = (req: LlmRequest) => req.turns[req.turns.length - 1]!.parts.some(p => 'functionResponse' in p);
    const llm = scriptedLlm((req, i) => i === 0 ? { text: 'Voy a consultar tus clientes ahora mismo.' }
      : afterTool(req) ? { text: 'Tienes 2 clientes.' }
      : lastUserText(req) === PROMISE_NUDGE_SPECIALIST ? { calls: [{ name: 'ainova__search_clients', args: {} }] } : { text: 'sin aviso' });
    const r = await runSpecialist(makeDeps(db, env, { llm }), { userId, conversationId: null, specialist: 'negocios', task: 'Cuenta los clientes' });
    assert.equal(r.calls, 1);
    assert.equal(r.text, 'Tienes 2 clientes.');
  });

  test('un especialista sin texto final dice lo que de verdad pasó (nada de «Listo.»)', async () => {
    reset();
    const none = await runSpecialist(makeDeps(db, noConnectors, { llm: scriptedLlm(() => ({ text: '' })) }), { userId, conversationId: null, specialist: 'negocios', task: 'x' });
    assert.match(none.text, /No obtuve respuesta del modelo.*no se hizo nada/);
    const some = await runSpecialist(makeDeps(db, env, { llm: scriptedLlm((_r, i) => i === 0 ? { calls: [{ name: 'ainova__search_clients', args: {} }] } : { text: '' }) }), { userId, conversationId: null, specialist: 'negocios', task: 'x' });
    assert.equal(some.calls, 1);
    assert.match(some.text, /Se hicieron las llamadas pero no pude redactar el resultado/);
    assert.doesNotMatch(some.text, /^Listo/);
  });

  test('varias delegaciones del mismo paso van en paralelo y sus respuestas conservan el orden', async () => {
    reset();
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    const llm = scriptedLlm(async req => {
      if (isMain(req)) {
        if (req.turns.length > 1) return { text: 'Resumen: A y B.' };
        return { calls: [{ name: 'delegar', args: { especialista: 'negocios', tarea: 'Tarea A' } }, { name: 'delegar', args: { especialista: 'documentos', tarea: 'Tarea B' } }] };
      }
      await wait(250);
      return { text: lastUserText(req).includes('Tarea A') ? 'Resultado A' : 'Resultado B' };
    });
    const t0 = Date.now();
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'Necesito revisar clientes y notas de la semana' });
    const ms = Date.now() - t0;
    assert.equal(r.reply, 'Resumen: A y B.');
    assert.ok(ms < 450, `en paralelo, no una tras otra (${ms} ms)`);
    const finalMain = llm.requests.filter(isMain).pop()!;
    const answers = finalMain.turns[finalMain.turns.length - 1]!.parts.map(p => ('functionResponse' in p ? String((p.functionResponse.response as { resultado?: string }).resultado) : ''));
    assert.deepEqual(answers, ['Resultado A', 'Resultado B']);
  });
});
