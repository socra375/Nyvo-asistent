// Órdenes breves y vagas («trabaja»): el modelo no puede contestar solo con cortesía («De nada, ¿en qué más puedo ayudarte?»).
// Modelo guionizado y servidores falsos: sin red ni claves.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeAllDbs, type Db } from '../../server/db/pool.js';
import { COURTESY_FALLBACK, COURTESY_NUDGE, isCourtesyOnly, isSocial, isVagueOrder, VAGUE_ORDER_HINT } from '../../server/agents/ordenes.js';
import { fastRoute } from '../../server/agents/fastRoute.js';
import { runTurn } from '../../server/agents/main.js';
import { listMessages } from '../../server/agents/conversations.js';
import type { LlmRequest } from '../../server/llm/types.js';
import { freshDb, makeDeps, makeUser, needsDb, scriptedLlm } from '../helpers.js';

describe('cortesía vacía, mensajes sociales y órdenes vagas (puro)', () => {
  test('isCourtesyOnly: cortesía de cierre sí; contenido, preguntas de negocio o texto largo no', () => {
    for (const t of ['De nada, ¿en qué más puedo ayudarte?', 'De nada.', '¿Algo más?', '¿Necesitas algo más?', 'A tu servicio.', 'Con gusto. ¿En qué más te puedo ayudar?', 'Con mucho gusto', 'No hay de qué', 'DE NADA, ¿EN QUÉ MÁS PUEDO AYUDARTE HOY?', 'Claro, ¿hay algo más en lo que pueda ayudarte?']) assert.ok(isCourtesyOnly(t), t);
    for (const t of [
      '', 'Hola', 'Tienes 2 clientes activos: Laura Méndez y Pedro Ruiz.', '¿Qué quieres que revise: cobros pendientes, clientes o tus archivos de Drive?',
      'El cobro de Café Brisa sigue pendiente: 450 dólares. De nada.', 'De nada, el cobro de Laura está pagado.', 'Con gusto reviso tus cobros pendientes de noviembre.',
      `De nada, ${'tienes cobros pendientes con varios clientes de la lista. '.repeat(6)}`, '¿En qué cliente quieres que trabaje?', 'Ahora mismo reviso tus clientes.'
    ]) assert.ok(!isCourtesyOnly(t), t.slice(0, 50));
  });

  test('isSocial: gracias, saludos, despedidas y «ok» sí; una orden o una consulta no', () => {
    for (const m of ['gracias', 'Gracias!', 'Muchas gracias', 'hola', 'Hola Nyvo', 'Buenos días', 'buenas tardes', 'adiós', 'Hasta luego', 'ok', 'vale', 'Perfecto', 'ok, gracias', 'Genial, muchas gracias', 'de acuerdo']) assert.ok(isSocial(m), m);
    for (const m of ['trabaja', 'hazlo', '', '¿Qué clientes tengo?', 'gracias, ahora revisa mis cobros pendientes', 'Hola, dame los clientes', 'de', 'ya', 'revisa los cobros']) assert.ok(!isSocial(m), m);
  });

  test('isVagueOrder: imperativos cortos sin tema sí; consultas, temas concretos o frases largas no', () => {
    for (const m of ['trabaja', 'Trabaja.', 'hazlo', 'Hazlo ya', 'continúa', 'sigue', 'adelante', 'procede', 'dale', 'empieza', 'dale nyvo', 'por favor, sigue']) assert.ok(isVagueOrder(m), m);
    for (const m of ['¿qué clientes tengo?', 'trabaja en los cobros de Laura', 'sigue con el reporte de cobros', 'hazlo con los clientes activos', 'gracias', 'hola', '', 'Dame los clientes', 'Marca como pagado el cobro de Café Brisa', 'clientes']) assert.ok(!isVagueOrder(m), m);
  });
});

describe('el turno ante una orden vaga', needsDb, () => {
  let db: Db; let userId: string;
  before(async () => { db = await freshDb(); userId = await makeUser(db); });
  after(async () => { await closeAllDbs(); });
  const noConnectors = {};   // sin conectores el especialista no tiene herramientas y contesta con texto
  const isMain = (r: LlmRequest) => !!r.tools?.some(t => t.name === 'delegar');
  const lastUserText = (r: LlmRequest) => r.turns.filter(t => t.role === 'user').flatMap(t => t.parts.map(p => ('text' in p ? p.text : ''))).filter(Boolean).pop() ?? '';
  const delegate = (tarea = 'x', especialista = 'negocios') => ({ calls: [{ name: 'delegar', args: { especialista, tarea } }] });
  const nudges = (llm: { requests: LlmRequest[] }) => llm.requests.filter(q => isMain(q) && lastUserText(q) === COURTESY_NUDGE).length;
  const COURTESY = 'De nada, ¿en qué más puedo ayudarte?';

  test('«trabaja» + cortesía: un solo aviso, el modelo delega y la respuesta final trae el resultado', async () => {
    const llm = scriptedLlm(req => {
      if (!isMain(req)) return { text: 'Tienes 2 cobros pendientes: Café Brisa y Laura.' };
      return lastUserText(req) === COURTESY_NUDGE ? delegate('Revisa los cobros pendientes') : { text: COURTESY };
    });
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'trabaja' });
    assert.equal(r.reply, 'Tienes 2 cobros pendientes: Café Brisa y Laura.');
    assert.equal(nudges(llm), 1);
    assert.doesNotMatch(r.reply, /de nada/i);
  });

  const VAGUE_TOPIC = 'y los cobros de Laura, ¿qué me dices?';   // no va por la ruta rápida (se refiere a lo dicho antes) pero tiene tema de negocio

  test('pregunta de negocio fuera de la ruta rápida + cortesía: un aviso, delega y responde con datos', async () => {
    assert.equal(fastRoute(VAGUE_TOPIC), null);
    const llm = scriptedLlm(req => {
      if (!isMain(req)) return { text: 'Laura debe 450 dólares.' };
      return lastUserText(req) === COURTESY_NUDGE ? delegate('Cobros de Laura') : { text: COURTESY };
    });
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: VAGUE_TOPIC });
    assert.equal(r.reply, 'Laura debe 450 dólares.');
    assert.equal(nudges(llm), 1);
  });

  test('el modelo insiste en cortesía ante una pregunta de negocio: se consulta directo al especialista, nunca se acepta la cortesía', async () => {
    const llm = scriptedLlm(req => isMain(req) ? { text: COURTESY } : { text: 'Laura debe 450 dólares.' });
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: VAGUE_TOPIC });
    assert.equal(r.reply, 'Laura debe 450 dólares.');
    assert.equal(llm.requests.filter(isMain).length, 2);
    assert.equal(nudges(llm), 1);
  });

  test('«trabaja» + el modelo insiste en cortesía (sin tema): la respuesta es la pregunta fija, nunca la cortesía', async () => {
    const llm = scriptedLlm(() => ({ text: COURTESY }));
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'trabaja' });
    assert.equal(r.reply, COURTESY_FALLBACK);
    assert.equal(llm.requests.length, 2);
    assert.equal(nudges(llm), 1);
  });

  test('«trabaja»: el modelo recibe la nota de orden breve, pero el mensaje guardado y el del dueño quedan intactos', async () => {
    const llm = scriptedLlm(() => ({ text: '¿Qué quieres que revise: cobros pendientes, clientes o tus archivos de Drive?' }));
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'trabaja' });
    assert.equal(llm.requests.length, 1, 'una pregunta concreta no es cortesía: sin aviso');
    assert.equal(lastUserText(llm.requests[0]!), 'trabaja' + VAGUE_ORDER_HINT);
    const saved = (await listMessages(db, userId, r.conversationId)).filter(m => m.role === 'user').map(m => m.content);
    assert.deepEqual(saved, ['trabaja']);
  });

  test('«gracias» → «De nada» se acepta sin aviso ni nota (no regresión)', async () => {
    const llm = scriptedLlm(() => ({ text: COURTESY }));
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'gracias' });
    assert.equal(r.reply, COURTESY);
    assert.equal(llm.requests.length, 1);
    assert.equal(lastUserText(llm.requests[0]!), 'gracias');
  });

  test('saludos y despedidas no reciben aviso', async () => {
    for (const [message, text] of [['hola', 'Hola, ¿en qué puedo ayudarte?'], ['Muchas gracias', 'Con gusto. ¿Algo más?'], ['adiós', 'A tu servicio.'], ['ok', 'De nada.']] as const) {
      const llm = scriptedLlm(() => ({ text }));
      const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message });
      assert.equal(llm.requests.length, 1, message);
      assert.equal(r.reply, text);
    }
  });

  test('una consulta normal no lleva nota y una respuesta con contenido que dice «de nada» no se bloquea', async () => {
    const text = 'De nada, el cobro de Café Brisa sigue pendiente: 450 dólares.';
    const llm = scriptedLlm(() => ({ text }));
    const r = await runTurn(makeDeps(db, noConnectors, { llm }), { userId, conversationId: null, message: 'Necesito saber cómo van mis cobros' });
    assert.equal(r.reply, text);
    assert.equal(llm.requests.length, 1);
    assert.ok(!lastUserText(llm.requests[0]!).includes('Orden breve'));
  });
});
