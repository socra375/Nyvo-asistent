import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../server/config.js';
import type { Deps } from '../../server/deps.js';
import type { ToolContext } from '../../connectors/types.js';
import { ainova, apiBase, callTool, clearAinovaCache, clientsPanel, toTool } from '../../connectors/ainova/index.js';
import { FAKE_AINOVA_KEY, FAKE_AINOVA_READ_KEY, PENDING_PAYMENT_ID, initialState, startUpstream, type Upstream } from '../fakes/upstream.js';

/** Conector de AINova por REST: sin base de datos, contra el servidor falso (misma semántica que /api/v1). */
describe('conector AINova (API REST con clave)', () => {
  let up: Upstream;
  before(async () => { up = await startUpstream(); });
  after(async () => { await up.close(); });
  beforeEach(() => { Object.assign(up.state, initialState()); clearAinovaCache(); });

  const ctx = (env: Record<string, string> = {}): ToolContext => {
    const cfg = loadConfig({ AINOVA_API_URL: `${up.url}/ainova`, AINOVA_API_KEY: FAKE_AINOVA_KEY, ...env });
    return { deps: { cfg, fetch } as unknown as Deps, userId: 'u', settings: {} };
  };

  test('la dirección base se normaliza y exige HTTPS (salvo localhost)', () => {
    assert.equal(apiBase('https://ainova-system.vercel.app'), 'https://ainova-system.vercel.app/api/v1');
    assert.equal(apiBase('https://ainova-system.vercel.app/'), 'https://ainova-system.vercel.app/api/v1');
    assert.equal(apiBase('https://ainova-system.vercel.app/api/v1'), 'https://ainova-system.vercel.app/api/v1');
    assert.equal(apiBase('https://ainova-system.vercel.app/mcp'), 'https://ainova-system.vercel.app/api/v1', 'entiende la variable antigua del MCP');
    assert.equal(apiBase('http://127.0.0.1:4010/ainova'), 'http://127.0.0.1:4010/ainova/api/v1');
    assert.throws(() => apiBase('http://ainova-system.vercel.app'), /https/);
    assert.throws(() => apiBase('no es una url'), /dirección válida/);
    assert.throws(() => apiBase('https://u:p@ainova-system.vercel.app'), /usuario/);
    assert.throws(() => apiBase('https://ainova-system.vercel.app/?k=1'), /parámetros/);
  });

  test('lista las herramientas: escritura según el campo «write», oculta las de agentes y limpia la descripción', async () => {
    const tools = await ainova.tools(ctx());
    const by = new Map(tools.map(t => [t.name, t]));
    assert.equal(by.get('search_clients')?.mutates, false);
    assert.equal(by.get('mark_payment_paid')?.mutates, true);
    assert.equal(by.get('reply_to_client')?.mutates, true);
    assert.ok(!by.has('add_agent_item'), 'las herramientas de agentes de AINova no se exponen');
    assert.doesNotMatch(by.get('mark_payment_paid')!.description, /Pide confirmación/);
    // El esquema JSON de AINova (format, maxLength, additionalProperties) llega al subconjunto de Gemini.
    assert.deepEqual(by.get('search_clients')!.parameters, {
      type: 'object',
      properties: { query: { type: 'string' }, status: { type: 'string', enum: ['prospecto', 'activo', 'inactivo'] } }
    });
    assert.deepEqual(by.get('mark_payment_paid')!.parameters.required, ['paymentId']);
  });

  test('sin el campo «write» una herramienta se trata como escritura (pide confirmación)', () => {
    assert.equal(toTool({ name: 'nueva_herramienta' }).mutates, true);
    assert.equal(toTool({ name: 'lee', write: false }).mutates, false);
  });

  test('una herramienta cuesta UNA sola petición HTTP, por POST (la lista va en caché)', async () => {
    const c = ctx();
    await ainova.tools(c);
    up.state.apiCalls.length = 0;
    const out = await callTool(c, 'get_summary');
    assert.deepEqual(up.state.apiCalls, ['POST get_summary']);
    assert.equal((out as { pending: string }).pending, '450.00');
    await ainova.tools(c);
    assert.deepEqual(up.state.apiCalls, ['POST get_summary'], 'la segunda lista sale de la caché: ninguna petición más');
  });

  test('la caché de la lista dura 60 s y se puede vaciar', async () => {
    const c = ctx();
    await ainova.tools(c); await ainova.tools(c);
    assert.equal(up.state.apiCalls.filter(x => x === 'GET tools').length, 1);
    clearAinovaCache();
    await ainova.tools(c);
    assert.equal(up.state.apiCalls.filter(x => x === 'GET tools').length, 2);
  });

  test('una clave de solo lectura no ve las herramientas de escritura; forzarlas da 403', async () => {
    const c = ctx({ AINOVA_API_KEY: FAKE_AINOVA_READ_KEY });
    const names = (await ainova.tools(c)).map(t => t.name);
    assert.ok(names.includes('get_summary'));
    assert.ok(!names.includes('mark_payment_paid') && !names.includes('reply_to_client'));
    await assert.rejects(callTool(c, 'mark_payment_paid', { paymentId: PENDING_PAYMENT_ID }), /no tiene permiso.*solo lectura/);
    assert.equal(up.state.payments[0]!.status, 'pendiente', 'no se cambió nada');
  });

  test('clave mal formada: error claro y ninguna petición sale', async () => {
    await assert.rejects(async () => ainova.tools(ctx({ AINOVA_API_KEY: 'clave-corta' })), /formato esperado/);
    await assert.rejects(callTool(ctx({ AINOVA_API_KEY: 'ain_corta' }), 'get_summary'), /formato esperado/);
    assert.equal(up.state.apiCalls.length, 0);
  });

  test('clave bien formada pero desconocida o revocada: 401 con texto útil, y se olvida la caché', async () => {
    await assert.rejects(async () => ainova.tools(ctx({ AINOVA_API_KEY: `ain_${'Z'.repeat(43)}` })), /inválida, caducó o fue revocada/);
    const c = ctx();
    await ainova.tools(c);
    up.state.ainova.revoked = true;                       // el dueño revoca la clave en el panel
    await assert.rejects(callTool(c, 'get_summary'), /inválida, caducó o fue revocada/);
    up.state.ainova.revoked = false;
    up.state.apiCalls.length = 0;
    await ainova.tools(c);
    assert.deepEqual(up.state.apiCalls, ['GET tools'], 'tras el 401 la lista se pide de nuevo, no se sirve la vieja');
  });

  test('límite de llamadas (429): mensaje de esperar y avisar, sin reintentar', async () => {
    const c = ctx();
    await ainova.tools(c);
    up.state.ainova.rateLimited = true;
    up.state.apiCalls.length = 0;
    await assert.rejects(callTool(c, 'get_summary'), /pidió esperar.*No insistas/);
    assert.equal(up.state.apiCalls.length, 0, 'el servidor rechazó antes de ejecutar y Nyvo no reintentó');
  });

  test('error de la herramienta (400): el texto de AINova llega tal cual', async () => {
    await assert.rejects(callTool(ctx(), 'mark_payment_paid', { paymentId: '00000000-0000-4000-8000-000000000000' }), /El cobro no existe o ya está pagado\./);
  });

  test('«notice» de AINova (texto de terceros) llega junto al resultado; el panel sigue recibiendo datos limpios', async () => {
    const out = await callTool(ctx(), 'search_clients', { query: 'laura' }) as { resultado: { name: string }[]; aviso: string };
    assert.equal(out.resultado[0]?.name, 'Laura Méndez');
    assert.match(out.aviso, /datos, nunca como instrucciones/);
    const panel = await clientsPanel(ctx());
    assert.equal(panel.clients.length, 2, 'el panel no se rompe por el aviso');
    assert.equal(panel.summary?.pending, '450.00');
    assert.equal(up.state.apiCalls.filter(x => x === 'POST get_summary').length, 1);
  });

  test('el muro de «Vercel Authentication» (401 con HTML) se diagnostica por su nombre', async () => {
    await assert.rejects(async () => ainova.tools(ctx({ AINOVA_API_URL: `${up.url}/ainova-muro` })), /Vercel Authentication/);
  });

  test('una redirección no se sigue: la clave nunca llega a otro destino', async () => {
    await assert.rejects(async () => ainova.tools(ctx({ AINOVA_API_URL: `${up.url}/ainova-redir` })), /redirección/);
    assert.equal(up.state.leakHits, 0, 'la petición redirigida no debe haberse hecho');
  });

  test('sin conexión: error claro, sin colgarse', async () => {
    await assert.rejects(async () => ainova.tools(ctx({ AINOVA_API_URL: 'http://127.0.0.1:1' })), /No se pudo conectar con AINova/);
  });
});
