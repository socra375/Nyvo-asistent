import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeAllDbs, type Db } from '../../server/db/pool.js';
import { runSpecialist } from '../../server/agents/specialists.js';
import { runTurn } from '../../server/agents/main.js';
import { confirmCard, cancelCard, undoCard, listCards } from '../../server/actions/actions.js';
import { connectorStatuses, toolsForRole, saveConnectorSettings } from '../../connectors/registry.js';
import { clientsPanel } from '../../connectors/ainova/index.js';
import { runTick } from '../../server/jobs/tick.js';
import { freshDb, makeDeps, makeUser, needsDb, scriptedLlm, settleDeferred } from '../helpers.js';
import { initialState, PENDING_PAYMENT_ID, startUpstream, upstreamEnv, type Upstream } from '../fakes/upstream.js';

describe('conectores, especialistas y tarjetas', needsDb, () => {
  let db: Db;
  let userId: string;
  let up: Upstream;
  let env: Record<string, string>;
  before(async () => { db = await freshDb(); userId = await makeUser(db); up = await startUpstream(); env = upstreamEnv(up.url, up.state); });
  after(async () => { await up.close(); await closeAllDbs(); });
  beforeEach(() => { Object.assign(up.state, initialState()); env.NOTION_ROOT_PAGE_ID = up.state.notionRoot; });

  test('sin variables, cada conector muestra «falta configurar» con la lista exacta', async () => {
    const st = await connectorStatuses(makeDeps(db, {}), userId);
    const ainova = st.find(c => c.id === 'ainova')!;
    assert.equal(ainova.state, 'falta_configurar');
    assert.deepEqual(ainova.missingEnv, ['AINOVA_API_URL', 'AINOVA_API_KEY']);
    assert.equal(st.find(c => c.id === 'memoria')!.state, 'listo');
    const voz = (await connectorStatuses(makeDeps(db, { VOICE_PROVIDER: 'elevenlabs' }), userId)).find(c => c.id === 'voz')!;
    assert.deepEqual(voz.missingEnv, ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'GROQ_API_KEY']);
    const spf = (await connectorStatuses(makeDeps(db, { VOICE_PROVIDER: ' Speechify ' }), userId)).find(c => c.id === 'voz')!;
    assert.deepEqual(spf.missingEnv, ['SPEECHIFY_API_KEY', 'SPEECHIFY_VOICE_ID', 'GROQ_API_KEY']);
    const conGroq = (await connectorStatuses(makeDeps(db, { VOICE_PROVIDER: 'speechify', GROQ_API_KEY: 'g' }), userId)).find(c => c.id === 'voz')!;
    assert.deepEqual(conGroq.missingEnv, ['SPEECHIFY_API_KEY', 'SPEECHIFY_VOICE_ID'], 'con GROQ_API_KEY la escucha está lista');
  });

  test('Drive con variables pero sin permiso de Google: «falta conectar»', async () => {
    const st = await connectorStatuses(makeDeps(db, env), userId);
    const drive = st.find(c => c.id === 'google-drive')!;
    assert.equal(drive.state, 'falta_conectar');
    assert.deepEqual(drive.missingScopes, ['https://www.googleapis.com/auth/drive.metadata.readonly']);
  });

  test('el registro arma las herramientas de AINova vía MCP con su tipo (lectura/escritura)', async () => {
    const { tools, unavailable } = await toolsForRole(makeDeps(db, env), userId, 'negocios');
    const byName = new Map(tools.map(t => [t.fullName, t.tool]));
    assert.equal(byName.get('ainova__search_clients')?.mutates, false);
    assert.equal(byName.get('ainova__mark_payment_paid')?.mutates, true);
    assert.ok(!byName.has('ainova__add_agent_item'), 'herramientas ocultas no se exponen');
    assert.ok(byName.has('memoria__recordar'));
    assert.deepEqual(unavailable, []);
    const off = await toolsForRole(makeDeps(db, { ...env, AINOVA_API_KEY: '' }), userId, 'negocios');
    assert.deepEqual(off.unavailable.map(u => u.state), ['falta_configurar']);
  });

  test('token incorrecto de AINova: el conector queda en error, sin romper', async () => {
    const { unavailable } = await toolsForRole(makeDeps(db, { ...env, AINOVA_API_KEY: `ain_${'Z'.repeat(43)}` }), userId, 'negocios');
    assert.equal(unavailable[0]?.state, 'error');
  });

  test('panel de clientes lee resumen y clientes de AINova', async () => {
    const deps = makeDeps(db, env);
    const p = await clientsPanel({ deps, userId, settings: {} });
    assert.equal(p.clients.length, 2);
    assert.equal(p.summary?.pending, '450.00');
  });

  test('una escritura en AINova NO se ejecuta: crea tarjeta; al confirmar se ejecuta una sola vez', async () => {
    const deps = makeDeps(db, env, {
      llm: scriptedLlm((_r, i) => i === 0 ? { calls: [{ name: 'ainova__mark_payment_paid', args: { paymentId: PENDING_PAYMENT_ID } }] } : { text: 'Pendiente de confirmación.' })
    });
    const r = await runSpecialist(deps, { userId, conversationId: null, specialist: 'negocios', task: 'Marca pagado el cobro' });
    assert.equal(r.cards.length, 1);
    assert.equal(r.cards[0]!.status, 'pending');
    assert.equal(up.state.payments[0]!.status, 'pendiente', 'no se ejecutó sin confirmar');
    const done = await confirmCard(deps, userId, r.cards[0]!.id);
    assert.equal(done.status, 'done');
    // Minimización: de lo que devolvió AINova solo se guardan identificadores, no el contenido del cobro.
    const stored = done.result as Record<string, unknown>;
    assert.equal(stored.id, PENDING_PAYMENT_ID);
    assert.ok(!('concept' in stored) && !('amount' in stored), 'el contenido del cobro no se copia a la base de Nyvo');
    assert.equal(up.state.payments[0]!.status, 'pagado');
    await assert.rejects(confirmCard(deps, userId, r.cards[0]!.id), /ya no está pendiente/);
    assert.equal(up.state.apiCalls.filter(c => c === 'POST mark_payment_paid').length, 1);
  });

  test('cancelar y caducar tarjetas', async () => {
    const llm = scriptedLlm((_r, i) => i % 2 === 0 ? { calls: [{ name: 'ainova__reply_to_client', args: { leadId: PENDING_PAYMENT_ID, body: 'Hola' } }] } : { text: 'ok' });
    const deps = makeDeps(db, env, { llm });
    const a = await runSpecialist(deps, { userId, conversationId: null, specialist: 'negocios', task: 'responde' });
    assert.equal((await cancelCard(deps, userId, a.cards[0]!.id)).status, 'cancelled');
    const b = await runSpecialist(deps, { userId, conversationId: null, specialist: 'negocios', task: 'responde' });
    await db.query(`update pending_actions set expires_at = now() - interval '1 minute' where id = $1`, [b.cards[0]!.id]);
    await assert.rejects(confirmCard(deps, userId, b.cards[0]!.id), /caduc|pendiente/);
    assert.equal((await listCards(deps, userId, { ids: [b.cards[0]!.id] }))[0]!.status, 'expired');
    assert.equal(up.state.replies.length, 0);
  });

  test('Notion: guardar nota se hace solo (excepción aprobada) y se puede deshacer', async () => {
    const deps = makeDeps(db, env, {
      llm: scriptedLlm((_r, i) => i === 0 ? { calls: [{ name: 'notion__guardar_nota', args: { titulo: 'Proveedor', contenido: 'El proveedor sube precios en enero' } }] } : { text: 'Guardado.' })
    });
    const r = await runSpecialist(deps, { userId, conversationId: null, specialist: 'documentos', task: 'Guarda la nota' });
    assert.equal(r.cards[0]?.kind, 'undo');
    const pages = [...up.state.notion.values()];
    const notas = pages.find(p => p.title === 'Notas')!;
    const nota = pages.find(p => p.parent === notas.id)!;
    assert.match(nota.title, /^Proveedor · \d{4}-\d{2}-\d{2}$/);
    assert.equal((await undoCard(deps, userId, r.cards[0]!.id)).status, 'undone');
    assert.equal(up.state.notion.get(nota.id)!.archived, true);
  });

  test('Notion: con autoGuardar desactivado, guardar nota pide confirmación', async () => {
    const deps = makeDeps(db, env, { llm: scriptedLlm((_r, i) => i === 0 ? { calls: [{ name: 'notion__guardar_nota', args: { titulo: 'X', contenido: 'Y' } }] } : { text: 'ok' }) });
    await saveConnectorSettings(deps, userId, 'notion', undefined, { autoGuardar: false });
    const r = await runSpecialist(deps, { userId, conversationId: null, specialist: 'documentos', task: 'Guarda' });
    assert.equal(r.cards[0]?.kind, 'confirm');
    assert.equal([...up.state.notion.values()].length, 1, 'no se creó nada');
    await saveConnectorSettings(deps, userId, 'notion', undefined, { autoGuardar: true });
  });

  test('el especialista solo ve la tarea, no la conversación', async () => {
    const llm = scriptedLlm(() => ({ text: 'ok' }));
    await runSpecialist(makeDeps(db, env, { llm }), { userId, conversationId: null, specialist: 'negocios', task: 'TAREA-ÚNICA' });
    const turns = llm.requests[0]!.turns;
    assert.equal(turns.length, 1);
    assert.match(JSON.stringify(turns), /TAREA-ÚNICA/);
  });

  test('tope de llamadas por petición', async () => {
    const llm = scriptedLlm(req => req.tools ? { calls: [{ name: 'ainova__get_summary', args: {} }] } : { text: 'Resumen parcial' });
    const r = await runSpecialist(makeDeps(db, env, { llm }), { userId, conversationId: null, specialist: 'negocios', task: 'bucle', maxCalls: 3 });
    assert.equal(r.calls, 3);
    assert.equal(r.partial, true);
    assert.equal(r.text, 'Resumen parcial');
    assert.equal(up.state.apiCalls.filter(c => c === 'POST get_summary').length, 3);
  });

  test('plazo por petición: devuelve resultado parcial', async () => {
    const llm = scriptedLlm(async req => {
      await new Promise((res, rej) => { const t = setTimeout(res, 3000); req.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('abortado')); }); });
      return { text: 'tarde' };
    });
    const t0 = Date.now();
    const r = await runSpecialist(makeDeps(db, env, { llm }), { userId, conversationId: null, specialist: 'negocios', task: 'lento', deadlineMs: 1000 });
    assert.ok(Date.now() - t0 < 2500);
    assert.equal(r.partial, true);
  });

  test('especialistas de fases futuras responden sin romper', async () => {
    const r = await runSpecialist(makeDeps(db, env), { userId, conversationId: null, specialist: 'navegador', task: 'x' });
    assert.match(r.text, /fase 4/);
  });

  test('turno completo con Gemini (servidor falso): delega en Negocios y guarda la respuesta', async () => {
    const deps = makeDeps(db, env);
    const r = await runTurn(deps, { userId, conversationId: null, message: '¿Qué clientes tengo?' });
    assert.match(r.reply, /Laura Méndez/);
    const msgs = (await db.query('select role, content from messages where conversation_id = $1 order by created_at', [r.conversationId])).rows;
    assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant']);
    const req = up.state.geminiRequests[0]!;
    assert.equal(req.model, 'modelo-falso');
    assert.ok(JSON.stringify(req.body).includes('delegar'));
  });

  test('tarea en segundo plano: se encola y el tick deja el resultado en la conversación', async () => {
    const deps = makeDeps(db, env);
    const r = await runTurn(deps, { userId, conversationId: null, message: 'Haz un reporte de cobros' });
    assert.equal(r.jobIds.length, 1);
    // runTurn ya dejó un procesamiento en segundo plano (defer): se espera a que termine y, si
    // quedara algo, runTick lo procesa. Sin la espera, ambos compiten por el trabajo y la prueba
    // comprueba el estado «running» antes de que acabe.
    await settleDeferred();
    await runTick(deps, 20_000);
    const job = (await db.query('select status from jobs where id = $1', [r.jobIds[0]])).rows[0]!;
    assert.equal(job.status, 'done');
    const stored = (await db.query<{ result: Record<string, unknown> }>('select result from jobs where id = $1', [r.jobIds[0]])).rows[0]!.result;
    assert.ok(!('texto' in stored) && typeof stored.caracteres === 'number', 'el texto ya está en el mensaje: no se duplica en la tabla de trabajos');
    const last = (await db.query(`select content, card_ids from messages where conversation_id = $1 order by created_at desc limit 1`, [r.conversationId])).rows[0]!;
    assert.match(last.content, /Trabajo terminado/);
    assert.equal(last.card_ids.length, 1);
    assert.ok([...up.state.notion.values()].some(p => p.title.startsWith('Cobros de noviembre')));
  });

  test('sin Gemini el chat responde «falta configurar» sin error', async () => {
    const r = await runTurn(makeDeps(db, {}, { llm: null }), { userId, conversationId: null, message: 'hola' });
    assert.match(r.reply, /Falta configurar Gemini/);
  });
});
