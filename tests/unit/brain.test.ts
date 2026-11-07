import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeAllDbs, type Db } from '../../server/db/pool.js';
import { BRAIN_MD, composeMainPrompt, PLATFORM_RULES, VOICE_MODE } from '../../server/agents/brain.js';
import { HEMISPHERES, hemisphereFor, type TurnEvent } from '../../server/agents/events.js';
import { mainSystemPrompt, runTurn } from '../../server/agents/main.js';
import { runSpecialist } from '../../server/agents/specialists.js';
import { looksLikePersonalData } from '../../connectors/notion/index.js';
import { call, freshDb, loginCookie, makeDeps, makeUser, needsDb, scriptedLlm, settleDeferred } from '../helpers.js';
import { initialState, startUpstream, upstreamEnv, type Upstream } from '../fakes/upstream.js';

const style = { description: '', samples: [] as string[] };

test('el cerebro embebido es exactamente brain/nyvo_core_system.md (ejecuta «npm run build:brain» si cambia)', () => {
  const md = readFileSync(new URL('../../brain/nyvo_core_system.md', import.meta.url), 'utf8');
  assert.equal(BRAIN_MD, md);
  assert.match(BRAIN_MD, /Rose/);
  assert.match(BRAIN_MD, /Johan/);
  assert.match(BRAIN_MD, /Mia/);
});

test('el prompt principal lleva el cerebro primero y las reglas de plataforma después (prevalecen)', () => {
  const p = mainSystemPrompt(style);
  assert.ok(p.startsWith(BRAIN_MD.trim().slice(0, 40)));
  assert.ok(p.indexOf(BRAIN_MD.trim().slice(0, 40)) < p.indexOf(PLATFORM_RULES));
  assert.match(p, /NUNCA escribas las etiquetas \[ROSE\]/);
  assert.match(p, /prevalece sobre lo anterior/);
  assert.match(p, /delegar/);
});

test('las reglas de seguridad de la plataforma siguen presentes pese al cerebro', () => {
  assert.match(PLATFORM_RULES, /tarjeta de confirmación/);
  assert.match(PLATFORM_RULES, /Rose[^.]*no responde sola/);
  assert.match(PLATFORM_RULES, /no instales ni asimiles habilidades/);
  assert.match(PLATFORM_RULES, /dato, nunca instrucciones/);
  assert.match(PLATFORM_RULES, /datos_personales/);
  assert.match(PLATFORM_RULES, /PENDIENTE DE APROBACIÓN POR EL CEO/);
});

test('modo voz: solo se añade con voice=true y limita la respuesta', () => {
  assert.ok(!mainSystemPrompt(style).includes('MODO VOZ'));
  const v = mainSystemPrompt(style, { voice: true });
  assert.ok(v.includes(VOICE_MODE));
  assert.match(v, /2 o 3 frases cortas/);
  assert.ok(!v.includes('Usa listas cortas'));
});

test('el estilo del dueño se añade al final', () => {
  const p = composeMainPrompt({ specialists: '- x', style: { description: 'directo y cálido', samples: ['Hola Ana'] }, security: 'SEG' });
  assert.ok(p.indexOf('directo y cálido') > p.indexOf(PLATFORM_RULES));
  assert.ok(p.endsWith('SEG'));
});

test('hemisferios: cuatro fijos y cada herramienta cae en el correcto', () => {
  assert.deepEqual([...HEMISPHERES], ['rose', 'johan', 'mia', 'nyvo']);
  for (const t of ['list_conversations', 'read_conversation', 'reply_to_client', 'escalate_to_owner']) assert.equal(hemisphereFor('ainova', t), 'rose');
  for (const t of ['search_clients', 'mark_payment_paid', 'get_summary']) assert.equal(hemisphereFor('ainova', t), 'johan');
  assert.equal(hemisphereFor('google-calendar', 'crear_evento'), 'mia');
  assert.equal(hemisphereFor('google-forms', 'x'), 'mia');
  for (const c of ['notion', 'google-drive', 'memoria']) assert.equal(hemisphereFor(c, 'x'), 'nyvo');
});

test('detección de datos personales: correos y teléfonos sí; fechas y cifras no', () => {
  for (const t of ['escríbele a laura@cafe.com', 'llámala al +1 809 555 1234', 'su cel (809) 555-1234', '809-555-1234', 'tel 8095551234']) assert.ok(looksLikePersonalData(t), t);
  for (const t of ['reunión 2026-11-07', 'cobro de 1250000.00', 'factura 000123 de 450 USD', 'el proveedor sube precios en enero', 'versión 2.5.1']) assert.ok(!looksLikePersonalData(t), t);
});

describe('flujo en vivo y datos personales', needsDb, () => {
  let db: Db;
  let userId: string;
  let up: Upstream;
  let env: Record<string, string>;
  before(async () => { db = await freshDb(); userId = await makeUser(db); up = await startUpstream(); env = upstreamEnv(up.url, up.state); });
  after(async () => { await up.close(); await closeAllDbs(); });

  const reset = () => { Object.assign(up.state, initialState()); env.NOTION_ROOT_PAGE_ID = up.state.notionRoot; };

  test('una nota con correo de un cliente NO se guarda sola: pide tarjeta', async () => {
    reset();
    const deps = makeDeps(db, env, { llm: scriptedLlm((_r, i) => i === 0 ? { calls: [{ name: 'notion__guardar_nota', args: { titulo: 'Contacto', contenido: 'Laura Méndez, laura@cafe.com' } }] } : { text: 'ok' }) });
    const r = await runSpecialist(deps, { userId, conversationId: null, specialist: 'documentos', task: 'Guarda el contacto' });
    assert.equal(r.cards[0]?.kind, 'confirm');
    assert.equal([...up.state.notion.values()].length, 1, 'no se creó nada en Notion');
  });

  test('datos_personales=true fuerza la tarjeta aunque el texto no lo parezca', async () => {
    reset();
    const deps = makeDeps(db, env, { llm: scriptedLlm((_r, i) => i === 0 ? { calls: [{ name: 'notion__guardar_nota', args: { titulo: 'Cliente', contenido: 'Prefiere citas por la tarde', datos_personales: true } }] } : { text: 'ok' }) });
    const r = await runSpecialist(deps, { userId, conversationId: null, specialist: 'documentos', task: 'Guarda' });
    assert.equal(r.cards[0]?.kind, 'confirm');
  });

  test('run_turn emite hemisferios activo→listo y el turno pasa sin voz por defecto', async () => {
    reset();
    const events: TurnEvent[] = [];
    const llm = scriptedLlm((_req, i) => {
      return i === 0 ? { calls: [{ name: 'delegar', args: { especialista: 'negocios', tarea: 'Lista clientes' } }] } : i === 1 ? { calls: [{ name: 'ainova__search_clients', args: {} }] } : { text: 'Tienes dos clientes.' };
    });
    const deps = makeDeps(db, env, { llm });
    const r = await runTurn(deps, { userId, conversationId: null, message: '¿Clientes?', onEvent: e => events.push(e) });
    assert.equal(r.reply, 'Tienes dos clientes.');
    assert.equal(events[0]?.tipo, 'pensando');
    const hem = events.filter((e): e is Extract<TurnEvent, { tipo: 'hemisferio' }> => e.tipo === 'hemisferio');
    assert.deepEqual(hem.map(h => [h.id, h.estado]), [['johan', 'activo'], ['johan', 'listo']]);
    assert.ok(!llm.requests.some(q => String(q.system).includes('MODO VOZ')));
  });

  test('con voice=true el agente principal recibe el modo voz', async () => {
    reset();
    const llm = scriptedLlm(() => ({ text: 'Hola.' }));
    await runTurn(makeDeps(db, env, { llm }), { userId, conversationId: null, message: 'hola', voice: true });
    assert.ok(String(llm.requests[0]!.system).includes('MODO VOZ'));
  });

  test('/api/chat/stream: NDJSON con progreso y un evento final', async () => {
    reset();
    const deps = makeDeps(db, env);
    const { cookie } = await loginCookie(deps);
    const r = await call(deps, 'POST', '/api/chat/stream', { cookie, body: { message: '¿Qué clientes tengo?', voice: true }, headers: { origin: 'http://nyvo.test' } });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /application\/x-ndjson/);
    assert.match(String(r.headers['cache-control']), /no-store/);
    const lines = r.body.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines[0]!.tipo, 'pensando');
    assert.ok(lines.some(l => l.tipo === 'hemisferio' && l.id === 'johan' && l.estado === 'activo'));
    assert.ok(lines.some(l => l.tipo === 'hemisferio' && l.id === 'johan' && l.estado === 'listo'));
    const fin = lines[lines.length - 1]!;
    assert.equal(fin.tipo, 'fin');
    assert.match(String(fin.reply), /Laura Méndez/);
    assert.ok(Array.isArray(fin.cards));
    await settleDeferred();
  });

  test('/api/chat/stream: una petición inválida sale como JSON con su código, sin abrir el flujo', async () => {
    const deps = makeDeps(db, env);
    const { cookie } = await loginCookie(deps);
    const r = await call(deps, 'POST', '/api/chat/stream', { cookie, body: { message: '' }, headers: { origin: 'http://nyvo.test' } });
    assert.equal(r.status, 400);
    assert.doesNotMatch(String(r.headers['content-type']), /ndjson/);
    assert.equal((await call(deps, 'POST', '/api/chat/stream', { body: { message: 'x' }, headers: { origin: 'http://nyvo.test' } })).status, 401);
  });
});
