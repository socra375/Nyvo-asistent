import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeAllDbs, type Db } from '../../server/db/pool.js';
import { runSpecialist } from '../../server/agents/specialists.js';
import { confirmCard, undoCard } from '../../server/actions/actions.js';
import { connectorStatuses, saveConnectorSettings } from '../../connectors/registry.js';
import { resetVaultCache } from '../../connectors/obsidian/index.js';
import { appendUpdate, buildNote, docFrom, findSecret, indexNote, notePath, parseNote, safePath, searchDocs, slugify } from '../../connectors/obsidian/vault.js';
import { freshDb, makeDeps, makeUser, needsDb, scriptedLlm } from '../helpers.js';
import { initialState, startUpstream, upstreamEnv, type Upstream } from '../fakes/upstream.js';

describe('segundo cerebro: lógica pura', () => {
  test('rutas: título → nombre de archivo, y nada que salga de la bóveda', () => {
    assert.equal(slugify('Cobro de Café Brisa: ¡urgente!'), 'cobro-de-cafe-brisa-urgente');
    assert.equal(slugify('¿¿??'), 'nota');
    assert.equal(notePath('conocimiento', 'Proveedor', '2026-11-11'), 'Nyvo/conocimiento/proveedor.md');
    assert.equal(notePath('decision', 'Subir precios', '2026-11-11'), 'Nyvo/decisiones/2026-11-11-subir-precios.md');
    assert.equal(safePath('/Nyvo/clientes/ana.md'), 'Nyvo/clientes/ana.md');
    for (const bad of ['../secreto.md', 'Nyvo/../../x.md', '.obsidian/app.md', 'Nyvo/.git/a.md', 'Nyvo/a.txt', '', 'Nyvo\\a.md', 'a//b.md']) assert.throws(() => safePath(bad), /./, bad);
  });

  test('secretos: se detectan claves, contraseñas y tarjetas; no los textos normales', () => {
    const secrets = [
      `La clave es AIza${'x'.repeat(35)}`, `usa sk-${'a'.repeat(30)} para el modelo`, `ghp_${'A'.repeat(36)}`, `gsk_${'b'.repeat(30)}`,
      'contraseña: Abc123!xyz', 'contraseña del panel de AINova: Zorro2026!', 'la clave de acceso al correo es mi_Clave99', 'password = hunter2023', 'el pin es 482915', 'tarjeta 4539 1488 0343 6467', 'IBAN ES9121000418450200051332',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', '-----BEGIN PRIVATE KEY-----', `ain_${'Z'.repeat(43)}`
    ];
    for (const t of secrets) assert.ok(findSecret(t), `debía detectar: ${t}`);
    const fine = ['El cliente pidió cambiar su contraseña la semana pasada', 'la clave es importante para el negocio', 'Teléfono 809-555-1234', 'Cobro de 1250000.00 el 2026-11-07',
      'Reunión el 12 de noviembre con Laura', 'Pedido 1234567890123 (no es tarjeta)', 'El token del proyecto lo guarda el equipo en el gestor de contraseñas'];
    for (const t of fine) assert.equal(findSecret(t), null, `no debía detectar: ${t}`);
  });

  test('nota: frontmatter con fuente y confianza, y la actualización añade sin borrar', () => {
    const raw = buildNote({ titulo: 'Proveedor de café', contenido: 'Sube precios en enero.', tipo: 'conocimiento', confianza: 'probable', fuente: 'Dicho por el dueño', relacionadas: ['Café Brisa'], fecha: '2026-11-11' });
    const p = parseNote(raw);
    assert.deepEqual([p.meta.title, p.meta.type, p.meta.confidence, p.meta.created, p.meta.updated, p.meta.author], ['Proveedor de café', 'conocimiento', 'probable', '2026-11-11', '2026-11-11', 'Nyvo']);
    assert.match(p.body, /Sube precios en enero\./);
    assert.match(raw, /\[\[Café Brisa\]\]/);
    const up = appendUpdate(raw, 'Ahora sube en febrero (contradice lo anotado).', 'confirmado', '2026-12-01', 'Dueño');
    assert.match(up, /Sube precios en enero\./, 'lo anterior se conserva');
    assert.match(up, /## Actualización 2026-12-01 \(confirmado\)\nAhora sube en febrero/);
    assert.equal(parseNote(up).meta.updated, '2026-12-01');
    assert.equal(parseNote(up).meta.created, '2026-11-11');
  });

  test('búsqueda: sin acentos ni mayúsculas, el título pesa, fragmento corto y sin coincidencias no inventa', () => {
    const docs = [
      docFrom('Nyvo/conocimiento/proveedor.md', 'a', buildNote({ titulo: 'Proveedor de café', contenido: 'El proveedor sube precios en enero. ' + 'relleno '.repeat(200), tipo: 'conocimiento', confianza: 'confirmado', fuente: 'x', relacionadas: [], fecha: '2026-11-11' })),
      docFrom('Diario/lunes.md', 'b', '# Lunes\nReunión con Laura Méndez sobre el sitio web.'),
      docFrom('Nyvo/clientes/pedro.md', 'c', buildNote({ titulo: 'Pedro Ruiz', contenido: 'Taller Ruiz, prospecto.', tipo: 'cliente', confianza: 'probable', fuente: 'x', relacionadas: [], fecha: '2026-11-10' }))
    ];
    assert.equal(searchDocs(docs, 'PROVEEDOR cafe')[0]!.ruta, 'Nyvo/conocimiento/proveedor.md');
    assert.equal(searchDocs(docs, 'laura mendez')[0]!.ruta, 'Diario/lunes.md');
    assert.equal(searchDocs(docs, 'laura mendez')[0]!.fragmento.includes('Reunión'), true);
    const hit = searchDocs(docs, 'precios enero')[0]!;
    assert.ok(hit.fragmento.length <= 290, `fragmento de ${hit.fragmento.length}`);
    assert.equal(hit.confianza, 'confirmado');
    assert.deepEqual(searchDocs(docs, 'astronomía cuántica'), []);
    assert.deepEqual(searchDocs(docs, 'de la el'), [], 'solo palabras vacías');
    assert.ok(indexNote('2026-11-11').includes('nunca guarda contraseñas'));
  });
});

describe('segundo cerebro: conector con GitHub falso', needsDb, () => {
  let db: Db; let userId: string; let up: Upstream; let env: Record<string, string>;
  before(async () => { db = await freshDb(); userId = await makeUser(db); up = await startUpstream(); env = upstreamEnv(up.url, up.state); });
  after(async () => { await up.close(); await closeAllDbs(); });
  beforeEach(() => { Object.assign(up.state, initialState()); resetVaultCache(); });

  const save = (args: Record<string, unknown>, name = 'obsidian__guardar_nota') => scriptedLlm((_r, i) => i === 0 ? { calls: [{ name, args }] } : { text: 'ok' });
  const run = (llm: ReturnType<typeof scriptedLlm>, e = env) => runSpecialist(makeDeps(db, e, { llm }), { userId, conversationId: null, specialist: 'documentos', task: 'tarea' });
  const toolResult = (llm: ReturnType<typeof scriptedLlm>) => {
    const last = llm.requests.at(-1)!.turns.at(-1)!;
    return (last.parts[0] as { functionResponse: { response: Record<string, unknown> } }).functionResponse.response;
  };

  test('guardar una nota: va a Nyvo/<tipo>/, con fuente y confianza, crea INDEX.md una sola vez y se puede deshacer', async () => {
    const llm = save({ titulo: 'Proveedor de café', contenido: 'Sube precios en enero.', tipo: 'conocimiento', confianza: 'confirmado' });
    const r = await run(llm);
    assert.equal(r.cards[0]?.kind, 'undo');
    const note = up.state.vault.get('Nyvo/conocimiento/proveedor-de-cafe.md')!;
    const meta = parseNote(note).meta;
    assert.deepEqual([meta.type, meta.confidence, meta.source, meta.author], ['conocimiento', 'confirmado', 'Dicho por el dueño en el chat con Nyvo', 'Nyvo']);
    assert.ok(up.state.vault.has('Nyvo/INDEX.md'));
    await run(save({ titulo: 'Otro dato', contenido: 'Otra cosa.' }));
    assert.equal(up.state.vaultCalls.filter(c => c === 'PUT Nyvo/INDEX.md').length, 1, 'el índice no se reescribe');
    assert.equal([...up.state.vault.keys()].filter(k => k.startsWith('Nyvo/') && k !== 'Nyvo/INDEX.md').length, 2);
    // Deshacer borra solo esa nota
    assert.equal((await undoCard(makeDeps(db, env), userId, r.cards[0]!.id)).status, 'undone');
    assert.equal(up.state.vault.has('Nyvo/conocimiento/proveedor-de-cafe.md'), false);
    assert.equal(up.state.vault.has('Nyvo/INDEX.md'), true);
  });

  test('secretos y datos bancarios se rechazan antes de escribir nada, y no queda ni una tarjeta', async () => {
    for (const contenido of [`La clave de Groq es gsk_${'a'.repeat(30)}`, 'tarjeta 4539 1488 0343 6467', 'contraseña del panel: Zorro2026!']) {
      const llm = save({ titulo: 'Acceso', contenido });
      const r = await run(llm);
      assert.match(String(toolResult(llm).error), /No guardo contraseñas/);
      assert.equal(r.cards.length, 0);
    }
    assert.equal(up.state.vault.size, 0);
    assert.equal(up.state.vaultCalls.some(c => c.startsWith('PUT')), false);
  });

  test('datos personales de un cliente piden tarjeta de confirmación; al confirmar se escribe', async () => {
    const deps = makeDeps(db, env, { llm: save({ titulo: 'Laura', contenido: 'Contacto: laura@cafebrisa.test', tipo: 'cliente' }) });
    const r = await runSpecialist(deps, { userId, conversationId: null, specialist: 'documentos', task: 'x' });
    assert.equal(r.cards[0]?.kind, 'confirm');
    assert.equal(up.state.vault.size, 0, 'todavía no se escribió');
    const done = await confirmCard(deps, userId, r.cards[0]!.id);
    assert.equal(done.status, 'done');
    assert.ok(up.state.vault.has('Nyvo/clientes/laura.md'));
  });

  test('con autoGuardar desactivado, guardar pide confirmación', async () => {
    const deps = makeDeps(db, env, { llm: save({ titulo: 'X', contenido: 'Y' }) });
    await saveConnectorSettings(deps, userId, 'obsidian', undefined, { autoGuardar: false });
    const r = await runSpecialist(deps, { userId, conversationId: null, specialist: 'documentos', task: 'x' });
    assert.equal(r.cards[0]?.kind, 'confirm');
    assert.equal(up.state.vault.size, 0);
    await saveConnectorSettings(deps, userId, 'obsidian', undefined, { autoGuardar: true });
  });

  test('duplicado: la misma nota no se crea dos veces, se avisa para anexar', async () => {
    await run(save({ titulo: 'Proveedor de café', contenido: 'Primera.' }));
    const llm = save({ titulo: 'Proveedor de Café', contenido: 'Segunda.' });
    const r = await run(llm);
    assert.equal((toolResult(llm).resultado as { duplicado?: boolean }).duplicado, true);
    assert.equal(r.cards.length, 0, 'sin tarjeta de deshacer: no se escribió nada');
    assert.equal([...up.state.vault.keys()].filter(k => k.includes('proveedor')).length, 1);
    assert.ok(!up.state.vault.get('Nyvo/conocimiento/proveedor-de-cafe.md')!.includes('Segunda.'));
  });

  test('anexar: dentro de Nyvo se hace solo y se deshace; fuera de Nyvo (notas propias) pide tarjeta; el texto anterior no llega al modelo', async () => {
    up.state.vault.set('Diario/lunes.md', '# Lunes\nReunión con Laura.');
    await run(save({ titulo: 'Proveedor de café', contenido: 'Sube precios en enero.' }));
    const before = up.state.vault.get('Nyvo/conocimiento/proveedor-de-cafe.md')!;
    const llm = save({ ruta: 'Nyvo/conocimiento/proveedor-de-cafe.md', contenido: 'Contradice lo anotado: ahora sube en febrero.', confianza: 'probable' }, 'obsidian__anexar_a_nota');
    const deps = makeDeps(db, env, { llm });
    const r = await runSpecialist(deps, { userId, conversationId: null, specialist: 'documentos', task: 'x' });
    const after = up.state.vault.get('Nyvo/conocimiento/proveedor-de-cafe.md')!;
    assert.ok(after.startsWith(before.replace(/updated: [^\n]+/, '').slice(0, 40)) && after.includes('Sube precios en enero.') && after.includes('Contradice lo anotado'), 'se conserva lo anterior');
    assert.equal(r.cards[0]?.kind, 'undo');
    assert.equal(JSON.stringify(toolResult(llm)).includes('_anterior'), false, 'el texto anterior es interno');
    assert.equal((await undoCard(deps, userId, r.cards[0]!.id)).status, 'undone');
    assert.equal(up.state.vault.get('Nyvo/conocimiento/proveedor-de-cafe.md'), before, 'vuelve exactamente al texto anterior');
    // Notas propias del dueño: tarjeta, sin escribir
    const own = await run(save({ ruta: 'Diario/lunes.md', contenido: 'Añadido por Nyvo' }, 'obsidian__anexar_a_nota'));
    assert.equal(own.cards[0]?.kind, 'confirm');
    assert.equal(up.state.vault.get('Diario/lunes.md'), '# Lunes\nReunión con Laura.');
    // Rutas fuera de la bóveda o ocultas fallan
    const bad = save({ ruta: '../../etc/passwd.md', contenido: 'x' }, 'obsidian__anexar_a_nota');
    await run(bad);
    assert.match(String(toolResult(bad).error), /Ruta de nota inválida/);
  });

  test('si la nota cambió mientras tanto, deshacer no pisa los cambios nuevos', async () => {
    const deps = makeDeps(db, env, { llm: save({ titulo: 'Dato', contenido: 'uno' }) });
    const r = await runSpecialist(deps, { userId, conversationId: null, specialist: 'documentos', task: 'x' });
    up.state.vault.set('Nyvo/conocimiento/dato.md', up.state.vault.get('Nyvo/conocimiento/dato.md')! + '\nEditado a mano en Obsidian');
    await assert.rejects(undoCard(deps, userId, r.cards[0]!.id), /cambió después/);
    assert.ok(up.state.vault.get('Nyvo/conocimiento/dato.md')!.includes('Editado a mano'));
  });

  test('buscar: encuentra por palabras en notas de Nyvo y propias, ignora .obsidian y lo que no es .md, y sin resultados no inventa', async () => {
    up.state.vault.set('.obsidian/app.json', '{"proveedor":"x"}');
    up.state.vault.set('.obsidian/notas.md', 'proveedor oculto');
    up.state.vault.set('Adjuntos/foto.png', 'proveedor binario');
    up.state.vault.set('Diario/lunes.md', '# Lunes\nReunión con Laura Méndez sobre el sitio web de Café Brisa.');
    await run(save({ titulo: 'Proveedor de café', contenido: 'Sube precios en enero.', confianza: 'confirmado' }));
    resetVaultCache();   // arranque en frío: el índice se arma desde GitHub
    const q1 = save({ consulta: 'proveedor' }, 'obsidian__buscar');
    await run(q1);
    const res1 = (toolResult(q1).resultado as { resultados: { ruta: string; confianza?: string; fragmento: string }[] }).resultados;
    assert.deepEqual(res1.map(x => x.ruta), ['Nyvo/conocimiento/proveedor-de-cafe.md']);
    assert.equal(res1[0]!.confianza, 'confirmado');
    const q2 = save({ consulta: 'laura mendez' }, 'obsidian__buscar');
    await run(q2);
    assert.equal((toolResult(q2).resultado as { resultados: { ruta: string }[] }).resultados[0]!.ruta, 'Diario/lunes.md');
    const q3 = save({ consulta: 'astronomía' }, 'obsidian__buscar');
    await run(q3);
    const none = toolResult(q3).resultado as { resultados: unknown[]; mensaje: string };
    assert.deepEqual(none.resultados, []);
    assert.match(none.mensaje, /No inventes/);
  });

  test('guardar y preguntar enseguida (misma instancia, sin arranque en frío): la nota recién guardada se encuentra', async () => {
    up.state.vault.set('Diario/lunes.md', '# Lunes\nReunión con Laura.');
    await run(scriptedLlm((_r, i) => i === 0 ? { calls: [{ name: 'obsidian__buscar', args: { consulta: 'lunes' } }] } : { text: 'ok' }));   // arma el índice y la lista de archivos
    await run(save({ titulo: 'Proveedor de café', contenido: 'Sube precios en enero.' }));
    const q = save({ consulta: 'proveedor' }, 'obsidian__buscar');
    await run(q);
    assert.deepEqual((toolResult(q).resultado as { resultados: { ruta: string }[] }).resultados.map(x => x.ruta), ['Nyvo/conocimiento/proveedor-de-cafe.md']);
    const dup = save({ titulo: 'Proveedor de café', contenido: 'otra vez' });
    await run(dup);
    assert.equal((toolResult(dup).resultado as { duplicado?: boolean }).duplicado, true);
  });

  test('buscar: no descarga toda la bóveda cada vez (solo lo nuevo o cambiado) y avisa si aún se está leyendo', async () => {
    for (let i = 0; i < 60; i++) up.state.vault.set(`Notas/n${String(i).padStart(2, '0')}.md`, `# Nota ${i}\nTema ${i === 59 ? 'jirafa' : 'común'}`);
    const q = (txt: string) => { const l = save({ consulta: txt }, 'obsidian__buscar'); return run(l).then(() => toolResult(l).resultado as { resultados: { ruta: string }[]; aviso?: string }); };
    const first = await q('común');
    assert.match(first.aviso ?? '', /20/, 'quedaban 20 notas por leer');
    assert.equal(up.state.vaultCalls.filter(c => c === 'GET contents').length, 40, 'máximo 40 descargas por llamada');
    const second = await q('jirafa');
    assert.equal(second.aviso, undefined);
    assert.equal(second.resultados[0]!.ruta, 'Notas/n59.md');
    assert.equal(up.state.vaultCalls.filter(c => c === 'GET contents').length, 60, 'la segunda llamada solo leyó las 20 que faltaban');
    const third = await q('jirafa');
    assert.equal(up.state.vaultCalls.filter(c => c === 'GET contents').length, 60, 'sin cambios no se descarga nada');
    assert.equal(third.resultados[0]!.ruta, 'Notas/n59.md');
  });

  test('una nota editada en Obsidian se ve en la siguiente búsqueda', async () => {
    up.state.vault.set('Diario/ideas.md', '# Ideas\nvender cursos');
    const q = async () => { const l = save({ consulta: 'cursos' }, 'obsidian__buscar'); await run(l); return (toolResult(l).resultado as { resultados: { fragmento: string }[] }).resultados; };
    assert.equal((await q()).length, 1);
    up.state.vault.set('Diario/ideas.md', '# Ideas\nvender talleres');
    // El árbol se guarda 60 s; una consulta nueva tras un arranque en frío ve el cambio
    resetVaultCache();
    assert.equal((await q()).length, 0);
  });

  test('leer_nota devuelve el texto (recortado) y dice si no existe', async () => {
    up.state.vault.set('Diario/larga.md', 'x'.repeat(9000));
    const l1 = save({ ruta: 'Diario/larga.md' }, 'obsidian__leer_nota');
    await run(l1);
    const r1 = toolResult(l1).resultado as { texto: string; recortado: boolean };
    assert.equal(r1.texto.length, 6000); assert.equal(r1.recortado, true);
    const l2 = save({ ruta: 'Diario/no-existe.md' }, 'obsidian__leer_nota');
    await run(l2);
    assert.match(String((toolResult(l2).resultado as { error: string }).error), /No existe/);
  });

  test('repositorio vacío = bóveda vacía; token malo da un mensaje claro sin filtrar el token', async () => {
    up.state.vaultEmptyRepo = true;
    const l = save({ consulta: 'algo' }, 'obsidian__buscar');
    await run(l);
    assert.deepEqual((toolResult(l).resultado as { resultados: unknown[] }).resultados, []);
    up.state.vaultEmptyRepo = false;
    const wrong = save({ consulta: 'algo' }, 'obsidian__buscar');
    await run(wrong, { ...env, OBSIDIAN_REPO: 'otro/repo' });
    assert.match(String(toolResult(wrong).error), /no encuentra el repositorio/);
    const badRepo = save({ consulta: 'algo' }, 'obsidian__buscar');
    await run(badRepo, { ...env, OBSIDIAN_REPO: 'sin-barra' });
    assert.match(String(toolResult(badRepo).error), /usuario\/repositorio/);
    assert.ok(!JSON.stringify([toolResult(wrong), toolResult(badRepo)]).includes('github-falso'));
  });

  test('sin variables: «falta configurar» con lo que falta, y con ellas queda listo', async () => {
    const none = await connectorStatuses(makeDeps(db, { ...env, OBSIDIAN_GITHUB_TOKEN: '', OBSIDIAN_REPO: '' }), userId);
    const o = none.find(c => c.id === 'obsidian')!;
    assert.equal(o.state, 'falta_configurar');
    assert.deepEqual(o.missingEnv, ['OBSIDIAN_GITHUB_TOKEN', 'OBSIDIAN_REPO']);
    assert.equal((await connectorStatuses(makeDeps(db, env), userId)).find(c => c.id === 'obsidian')!.state, 'listo');
  });
});
