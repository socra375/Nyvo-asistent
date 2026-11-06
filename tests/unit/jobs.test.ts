import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeAllDbs, type Db } from '../../server/db/pool.js';
import { claim, complete, enqueue, fail, listJobs, retryJob, cancelJob } from '../../server/jobs/queue.js';
import { HANDLERS, runTick } from '../../server/jobs/tick.js';
import { freshDb, makeDeps, makeUser, needsDb } from '../helpers.js';

describe('cola de trabajos', needsDb, () => {
  let db: Db;
  let userId: string;
  before(async () => { db = await freshDb(); userId = await makeUser(db); });
  after(() => closeAllDbs());

  test('encolar, reclamar y completar', async () => {
    const j = await enqueue(db, { userId, kind: 'prueba', title: 'Uno', payload: { a: 1 } });
    assert.equal(j.status, 'queued');
    const c = await claim(db);
    assert.equal(c?.id, j.id);
    assert.equal(c?.status, 'running');
    assert.equal(c?.attempts, 1);
    assert.equal(await claim(db), null, 'un trabajo en curso no se reclama dos veces');
    await complete(db, j.id, { ok: true });
    const [done] = await listJobs(db, userId);
    assert.equal(done?.status, 'done');
    assert.deepEqual(done?.result, { ok: true });
  });

  test('reintento con espera y fallo definitivo al agotar intentos', async () => {
    const j = await enqueue(db, { userId, kind: 'prueba', title: 'Dos', payload: {}, maxAttempts: 2 });
    const c1 = (await claim(db))!;
    assert.equal(await fail(db, c1, 'boom'), 'retry');
    assert.equal(await claim(db), null, 'espera antes de reintentar');
    await db.query(`update jobs set run_after = now() where id = $1`, [j.id]);
    const c2 = (await claim(db))!;
    assert.equal(c2.attempts, 2);
    assert.equal(await fail(db, c2, 'boom otra vez'), 'failed');
    const row = (await db.query('select status, error from jobs where id = $1', [j.id])).rows[0]!;
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'boom otra vez');
    assert.equal((await retryJob(db, userId, j.id))?.status, 'queued');
    await db.query(`update jobs set status = 'done' where id = $1`, [j.id]);
  });

  test('dos instancias no toman el mismo trabajo (SKIP LOCKED)', async () => {
    await enqueue(db, { userId, kind: 'prueba', title: 'A', payload: {} });
    await enqueue(db, { userId, kind: 'prueba', title: 'B', payload: {} });
    const [a, b] = await Promise.all([claim(db), claim(db)]);
    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
    await complete(db, a.id, null);
    await complete(db, b.id, null);
  });

  test('si Vercel corta la ejecución, el bloqueo vence y se recupera', async () => {
    const j = await enqueue(db, { userId, kind: 'prueba', title: 'Cortado', payload: {} });
    await claim(db);
    await db.query(`update jobs set locked_until = now() - interval '1 second' where id = $1`, [j.id]);
    const again = await claim(db);
    assert.equal(again?.id, j.id);
    assert.equal(again?.attempts, 2);
    await complete(db, j.id, null);
  });

  test('cancelar solo trabajos en cola', async () => {
    const j = await enqueue(db, { userId, kind: 'prueba', title: 'Cancelar', payload: {} });
    assert.equal((await cancelJob(db, userId, j.id))?.status, 'cancelled');
    assert.equal(await cancelJob(db, userId, j.id), null);
  });

  test('runTick ejecuta handlers y registra errores', async () => {
    const deps = makeDeps(db);
    HANDLERS.eco = async (_d, job) => ({ eco: job.payload.x });
    HANDLERS.roto = async () => { throw new Error('se rompió'); };
    const ok = await enqueue(db, { userId, kind: 'eco', title: 'Eco', payload: { x: 5 } });
    const bad = await enqueue(db, { userId, kind: 'roto', title: 'Roto', payload: {}, maxAttempts: 1 });
    const r = await runTick(deps, 10_000);
    assert.equal(r.processed, 1);
    assert.equal(r.failed, 1);
    const rows = new Map((await db.query('select id, status, result, error from jobs where id = any($1)', [[ok.id, bad.id]])).rows.map(x => [x.id, x]));
    assert.deepEqual(rows.get(ok.id)!.result, { eco: 5 });
    assert.equal(rows.get(bad.id)!.status, 'failed');
    delete HANDLERS.eco; delete HANDLERS.roto;
  });
});
