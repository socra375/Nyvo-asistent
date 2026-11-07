import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeAllDbs, type Db } from '../../server/db/pool.js';
import { encrypt, hashPassword, parseKey, sha256 } from '../../server/crypto.js';
import { purgeExpired, purgeIfDue } from '../../server/retention.js';
import { call, ENC_KEY, freshDb, loginCookie, makeDeps, needsDb, type FakeResponse } from '../helpers.js';

/** Código de error de Postgres (23503 = clave foránea, 23514 = CHECK) o undefined si no falló. */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; }
}

describe('base de datos: aislamiento, secretos, tamaños, permisos y retención', needsDb, () => {
  let db: Db;
  before(async () => { db = await freshDb(); });
  after(() => closeAllDbs());

  const user = async (email: string) => (await db.query<{ id: string }>('insert into users (email) values ($1) returning id', [email])).rows[0]!.id;
  const conv = async (u: string) => (await db.query<{ id: string }>('insert into conversations (user_id, title) values ($1, $2) returning id', [u, 'c'])).rows[0]!.id;
  const card = (u: string, c: string | null) => db.query(
    `insert into pending_actions (user_id, conversation_id, kind, connector_id, tool, args, summary, status, expires_at)
     values ($1, $2, 'confirm', 'x', 't', '{}', 's', 'pending', now() + interval '1 hour')`, [u, c]);

  test('una fila no puede colgar de la conversación de OTRO usuario (messages, jobs, pending_actions)', async () => {
    const a = await user('a1@x.com'); const b = await user('b1@x.com'); const cA = await conv(a);
    const msg = (u: string) => db.query(`insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'user', 'hola')`, [cA, u]);
    const job = (u: string | null) => db.query(`insert into jobs (user_id, conversation_id, kind) values ($1, $2, 'k')`, [u, cA]);
    assert.equal(await pgCode(msg(b)), '23503', 'mensaje de B en la conversación de A');
    assert.equal(await pgCode(msg(a)), undefined, 'el dueño sí puede');
    assert.equal(await pgCode(job(b)), '23503', 'trabajo de B en la conversación de A');
    assert.equal(await pgCode(job(a)), undefined);
    assert.equal(await pgCode(card(b, cA)), '23503', 'tarjeta de B en la conversación de A');
    assert.equal(await pgCode(card(a, cA)), undefined);
    assert.equal(await pgCode(job(null)), '23514', 'un trabajo sin usuario no puede tener conversación (la clave compuesta no se comprueba con NULL)');
    assert.equal(await pgCode(db.query(`insert into jobs (user_id, kind) values (null, 'sistema')`)), undefined, 'los trabajos del sistema siguen permitidos');
  });

  test('al borrar la conversación: se van sus mensajes; trabajos y tarjetas conservan dueño y pierden solo la referencia', async () => {
    const a = await user('a2@x.com'); const cA = await conv(a);
    await db.query(`insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'user', 'x')`, [cA, a]);
    await db.query(`insert into jobs (user_id, conversation_id, kind) values ($1, $2, 'k')`, [a, cA]);
    await card(a, cA);
    await db.query('delete from conversations where id = $1', [cA]);
    assert.equal((await db.query('select 1 from messages where conversation_id = $1', [cA])).rowCount, 0);
    const j = (await db.query<{ user_id: string; conversation_id: string | null }>('select user_id, conversation_id from jobs where user_id = $1', [a])).rows;
    const c = (await db.query<{ user_id: string; conversation_id: string | null }>('select user_id, conversation_id from pending_actions where user_id = $1', [a])).rows;
    assert.deepEqual([j.length, j[0]?.user_id, j[0]?.conversation_id], [1, a, null]);
    assert.deepEqual([c.length, c[0]?.user_id, c[0]?.conversation_id], [1, a, null]);
  });

  test('un secreto en claro no entra: contraseña, token de sesión, tokens de Google y verificador PKCE', async () => {
    const key = parseKey(ENC_KEY)!;
    const u = await user('sec@x.com');
    const upd = (sql: string, p: unknown[]) => db.query(sql, p);
    assert.equal(await pgCode(upd('update users set password_hash = $2 where id = $1', [u, 'hunter2'])), '23514');
    assert.equal(await pgCode(upd('update users set password_hash = $2 where id = $1', [u, await hashPassword('una-clave-larga-123')])), undefined);
    const ses = (t: string) => db.query(`insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')`, [u, t]);
    assert.equal(await pgCode(ses('el-token-en-claro-abc')), '23514');
    assert.equal(await pgCode(ses(sha256('token-1'))), undefined);
    const acc = (a: string | null, r: string | null) => db.query(`insert into oauth_accounts (user_id, provider, access_token_enc, refresh_token_enc) values ($1, 'google', $2, $3) on conflict (user_id, provider) do update set access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc`, [u, a, r]);
    assert.equal(await pgCode(acc('ya29.token-en-claro', null)), '23514');
    assert.equal(await pgCode(acc(encrypt('a', key), 'refresh-en-claro')), '23514');
    assert.equal(await pgCode(acc(encrypt('a', key), encrypt('r', key))), undefined);
    const st = (h: string, v: string) => db.query(`insert into oauth_states (state_hash, user_id, purpose, verifier_enc, expires_at) values ($1, $2, 'login', $3, now() + interval '10 minutes')`, [h, u, v]);
    assert.equal(await pgCode(st(sha256('s1'), 'verificador-en-claro')), '23514');
    assert.equal(await pgCode(st('estado-en-claro', encrypt('v', key))), '23514');
    assert.equal(await pgCode(st(sha256('s2'), encrypt('v', key))), undefined);
  });

  test('el correo se guarda en minúsculas y con forma de correo', async () => {
    const ins = (e: string) => db.query('insert into users (email) values ($1)', [e]);
    assert.equal(await pgCode(ins('MAYUS@x.com')), '23514');
    assert.equal(await pgCode(ins('sin-arroba')), '23514');
    assert.equal(await pgCode(ins('con espacio@x.com')), '23514');
    assert.equal(await pgCode(ins('ok@x.com')), undefined);
  });

  test('límites de tamaño: un campo libre no puede ser un volcado de datos', async () => {
    const a = await user('size@x.com'); const big = 'x'.repeat(70_000);
    assert.equal(await pgCode(db.query(`insert into pending_actions (user_id, kind, connector_id, tool, args, summary, status, expires_at) values ($1, 'confirm', 'x', 't', $2, 's', 'pending', now() + interval '1 hour')`, [a, JSON.stringify({ big })])), '23514');
    assert.equal(await pgCode(db.query(`insert into jobs (user_id, kind, payload) values ($1, 'k', $2)`, [a, JSON.stringify({ big })])), '23514');
    const c = await conv(a);
    assert.equal(await pgCode(db.query(`insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'user', $3)`, [c, a, 'y'.repeat(20_001)])), '23514');
    assert.equal(await pgCode(db.query(`insert into audit_log (user_id, action, detail) values ($1, 'x', $2)`, [a, JSON.stringify({ d: 'z'.repeat(5000) })])), '23514');
    assert.equal(await pgCode(db.query(`insert into audit_log (user_id, action, detail) values ($1, 'x', $2)`, [a, JSON.stringify({ d: 'ok' })])), undefined);
  });

  test('PUBLIC no tiene ningún permiso sobre las tablas, ni sobre las que se creen después', async () => {
    const tables = (await db.query<{ relname: string }>(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`)).rows.map(r => r.relname);
    assert.ok(tables.length >= 13);
    for (const t of tables) {
      for (const priv of ['select', 'insert', 'update', 'delete']) {
        const r = await db.query<{ ok: boolean }>(`select has_table_privilege('public', $1, $2) as ok`, [`public.${t}`, priv]);
        assert.equal(r.rows[0]!.ok, false, `PUBLIC no debería tener ${priv} sobre ${t}`);
      }
    }
    await db.query('create table zz_futura (id int)');
    const r = await db.query<{ ok: boolean }>(`select has_table_privilege('public', 'public.zz_futura', 'select') as ok`);
    await db.query('drop table zz_futura');
    assert.equal(r.rows[0]!.ok, false, 'las tablas futuras tampoco');
  });

  test('guardas de diseño: toda tabla lleva user_id y comentario de qué guarda, y toda clave foránea tiene índice', async () => {
    const SIN_USUARIO = ['schema_migrations', 'rate_limits', 'users'];   // únicas excepciones, justificadas en docs/DATABASE.md (users: su id ES el usuario)
    const sinUserId = await db.query<{ t: string }>(
      `select c.relname as t from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> all($1)
         and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped)`, [SIN_USUARIO]);
    assert.deepEqual(sinUserId.rows, [], 'tablas nuevas sin user_id: ¿cómo se aislarían entre usuarios?');
    const sinComentario = await db.query<{ t: string }>(
      `select c.relname as t from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
         and c.relname <> 'schema_migrations' and obj_description(c.oid, 'pg_class') is null`);
    assert.deepEqual(sinComentario.rows, [], 'tablas sin comentario de sensibilidad y retención');
    const fkSinIndice = await db.query<{ tabla: string; conname: string }>(
      `select c.conrelid::regclass::text as tabla, c.conname from pg_constraint c
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace
          and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`);
    assert.deepEqual(fkSinIndice.rows, [], 'claves foráneas sin índice (borrados lentos y bloqueos)');
  });

  test('retención: lo caducado se purga, el detalle viejo se vacía y lo reciente no se toca (y es idempotente)', async () => {
    const a = await user('ret@x.com');
    await db.query(`insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() - interval '1 hour'), ($1, $3, now() + interval '1 day')`, [a, sha256('s-old'), sha256('s-ok')]);
    await db.query(`insert into oauth_states (state_hash, user_id, purpose, verifier_enc, expires_at) values ($1, $3, 'login', 'v1.x', now() - interval '1 minute'), ($2, $3, 'login', 'v1.x', now() + interval '5 minutes')`, [sha256('o-old'), sha256('o-ok'), a]);
    await db.query(`insert into rate_limits (key, count, window_start) values ('login:1.1.1.1', 3, now() - interval '2 days'), ('login:2.2.2.2', 1, now())`);
    // tarjetas
    const act = (status: string, created: string, args = '{"cliente":"Ana"}', result: string | null = '{"id":1}', undo: string | null = '{"pageId":"p"}', expires = `now() + interval '1 hour'`) =>
      db.query(`insert into pending_actions (user_id, kind, connector_id, tool, args, summary, status, result, undo, expires_at, created_at) values ($1, 'confirm', 'x', $2, $3, 's', $4, $5, $6, ${expires}, ${created})`, [a, `t-${status}-${created.length}`, args, status, result, undo]);
    await act('pending', 'now()', '{}', null, null, `now() - interval '1 minute'`);               // caducó sin resolverse
    await act('done', `now() - interval '40 days'`);                                              // detalle viejo
    await act('done', `now() - interval '200 days'`);                                             // muy viejo
    await act('done', 'now()');                                                                   // reciente
    // trabajos
    const jb = (status: string, updated: string) => db.query(`insert into jobs (user_id, kind, status, payload, result, updated_at) values ($1, $2, $3, '{"tarea":"x"}', '{"r":1}', ${updated})`, [a, `k-${status}-${updated.length}`, status]);
    await jb('done', `now() - interval '20 days'`);
    await jb('done', `now() - interval '100 days'`);
    await jb('running', `now() - interval '100 days'`);
    await jb('queued', 'now()');
    // auditoría
    const au = (created: string) => db.query(`insert into audit_log (user_id, action, detail, created_at) values ($1, 'x', '{"ip":"1.2.3.4","k":1}', ${created})`, [a]);
    await au(`now() - interval '100 days'`);
    await au(`now() - interval '400 days'`);
    await au('now()');

    const r = await purgeExpired(db);
    assert.deepEqual(
      [r.sesiones, r.estadosOauth, r.limites, r.tarjetasCaducadas, r.tarjetasDepuradas, r.tarjetasBorradas, r.trabajosDepurados, r.trabajosBorrados, r.ipAuditoria, r.auditoriaBorrada],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    assert.equal((await db.query('select 1 from sessions where user_id = $1', [a])).rowCount, 1, 'la sesión vigente se conserva');
    assert.equal((await db.query('select 1 from oauth_states where user_id = $1', [a])).rowCount, 1);
    assert.equal((await db.query(`select 1 from rate_limits where key like 'login:%'`)).rowCount, 1);
    const cards = (await db.query<{ status: string; args: unknown; result: unknown; undo: unknown }>(`select status, args, result, undo from pending_actions where user_id = $1 order by created_at`, [a])).rows;
    assert.equal(cards.length, 3, 'la de 200 días se borró');
    const depurada = cards.find(c => c.status === 'done' && JSON.stringify(c.args) === '{}')!;
    assert.deepEqual([depurada.args, depurada.result, depurada.undo], [{}, null, null], 'a los 40 días se vacía el detalle');
    assert.ok(cards.some(c => c.status === 'expired'), 'la pendiente caducada pasa a «expired»');
    const reciente = cards.find(c => c.status === 'done' && JSON.stringify(c.args) !== '{}')!;
    assert.deepEqual([reciente.args, reciente.result], [{ cliente: 'Ana' }, { id: 1 }], 'la reciente conserva su detalle');
    const jobs = (await db.query<{ status: string; payload: unknown; result: unknown }>(`select status, payload, result from jobs where user_id = $1`, [a])).rows;
    assert.equal(jobs.length, 3, 'el terminado de 100 días se borró; el «running» antiguo NO se toca');
    const done = jobs.find(j => j.status === 'done')!;
    assert.deepEqual([done.payload, done.result], [{}, null]);
    assert.deepEqual(jobs.find(j => j.status === 'queued')!.payload, { tarea: 'x' });
    const logs = (await db.query<{ detail: Record<string, unknown> }>(`select detail from audit_log where user_id = $1 order by created_at`, [a])).rows;
    assert.equal(logs.length, 2, 'la de 400 días se borró');
    assert.deepEqual(logs[0]!.detail, { k: 1 }, 'a los 100 días la IP desaparece y el resto queda');
    assert.deepEqual(logs[1]!.detail, { ip: '1.2.3.4', k: 1 }, 'la reciente conserva la IP');

    const again = await purgeExpired(db);
    assert.ok(Object.values(again).every(v => v === 0), 'una segunda pasada no encuentra nada: idempotente');
  });

  test('la purga se ejecuta como mucho una vez por hora', async () => {
    await db.query(`delete from rate_limits where key = 'purga-retencion'`);
    assert.ok(await purgeIfDue(db), 'la primera vez corre');
    assert.equal(await purgeIfDue(db), null, 'la segunda, dentro de la hora, no');
  });

  test('nadie ve ni toca los datos de otro usuario por la API (conversaciones, tarjetas, trabajos, memoria, conectores)', async () => {
    const deps = makeDeps(db);
    const A = await loginCookie(deps, 'dueno-a@x.com');
    const B = await loginCookie(deps, 'dueno-b@x.com');
    const cA = await conv(A.userId);
    await db.query(`insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'user', 'secreto de A')`, [cA, A.userId]);
    const cardId = (await db.query<{ id: string }>(`insert into pending_actions (user_id, conversation_id, kind, connector_id, tool, args, summary, status, expires_at) values ($1, $2, 'confirm', 'x', 't', '{"dato":"A"}', 'acción de A', 'pending', now() + interval '1 hour') returning id`, [A.userId, cA])).rows[0]!.id;
    const jobId = (await db.query<{ id: string }>(`insert into jobs (user_id, conversation_id, kind, status, title) values ($1, $2, 'k', 'failed', 'trabajo de A') returning id`, [A.userId, cA])).rows[0]!.id;
    const noteId = (await db.query<{ id: string }>(`insert into memory_notes (user_id, content) values ($1, 'nota de A') returning id`, [A.userId])).rows[0]!.id;
    const j = (r: FakeResponse) => r.json();
    const as = (who: { cookie: string }, method: string, path: string, body?: unknown) => call(deps, method, path, { cookie: who.cookie, body });

    // B no ve nada de A.
    assert.deepEqual(j(await as(B, 'GET', '/api/conversations')).conversations, []);
    const m = j(await as(B, 'GET', `/api/conversations/${cA}/messages`));
    assert.deepEqual([m.messages, m.cards], [[], []]);
    assert.deepEqual(j(await as(B, 'GET', '/api/actions')).cards, []);
    assert.deepEqual(j(await as(B, 'GET', '/api/jobs')).jobs, []);
    assert.deepEqual(j(await as(B, 'GET', '/api/memory')).notes, []);
    assert.deepEqual(j(await as(B, 'GET', '/api/memory/export')).notas, []);
    // B no puede actuar sobre lo de A.
    assert.equal((await as(B, 'DELETE', `/api/conversations/${cA}`)).status, 404);
    for (const verb of ['confirm', 'cancel', 'undo']) assert.equal((await as(B, 'POST', `/api/actions/${cardId}/${verb}`)).status, 409, verb);
    assert.equal((await as(B, 'POST', `/api/jobs/${jobId}/retry`)).status, 409);
    assert.equal((await as(B, 'POST', `/api/jobs/${jobId}/cancel`)).status, 409);
    assert.equal((await as(B, 'DELETE', `/api/memory/${noteId}`)).status, 404);
    await as(B, 'DELETE', '/api/memory');                                                   // «borrar toda mi memoria» de B
    await as(B, 'PUT', '/api/connectors/notion', { enabled: false });

    // Lo de A sigue intacto.
    assert.equal((await db.query(`select 1 from conversations where id = $1`, [cA])).rowCount, 1);
    assert.equal((await db.query<{ status: string }>(`select status from pending_actions where id = $1`, [cardId])).rows[0]!.status, 'pending');
    assert.equal((await db.query<{ status: string }>(`select status from jobs where id = $1`, [jobId])).rows[0]!.status, 'failed');
    assert.equal((await db.query(`select 1 from memory_notes where id = $1`, [noteId])).rowCount, 1, 'borrar la memoria de B no toca la de A');
    assert.equal((await db.query(`select 1 from connector_settings where user_id = $1`, [A.userId])).rowCount, 0);
    // Y A sí lo ve.
    assert.equal(j(await as(A, 'GET', '/api/conversations')).conversations.length, 1);
    assert.equal(j(await as(A, 'GET', '/api/memory')).notes.length, 1);
  });
});
