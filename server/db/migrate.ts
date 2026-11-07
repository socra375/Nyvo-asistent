import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getDb, closeAllDbs, type Db } from './pool.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Aplica, en orden, las migraciones numeradas que falten. Nunca se edita una migración ya aplicada. */
export async function migrate(db: Db, log: (m: string) => void = () => undefined): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ name: string }>('select name from schema_migrations')).rows.map(r => r.name));
  const files = (await readdir(DIR)).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(DIR, f), 'utf8');
    await db.tx(async t => {
      await t.query('select pg_advisory_xact_lock(4207001)');
      const again = await t.query('select 1 from schema_migrations where name = $1', [f]);
      if (again.rowCount) return;
      await t.query(sql);
      await t.query('insert into schema_migrations (name) values ($1)', [f]);
      applied.push(f);
      log(`migración aplicada: ${f}`);
    });
  }
  return applied;
}

/**
 * ¿Debe aplicarse la migración en este build? Con `--production-only` solo en producción de Vercel.
 * Las vistas previas comparten la base de producción (Neon inyecta el mismo DATABASE_URL en ambos entornos):
 * si migraran, una migración sin revisar tocaría la base real antes de fusionar el PR.
 */
export function migrationPolicy(argv: readonly string[], env: Record<string, string | undefined>): { run: boolean; reason?: string } {
  if (argv.includes('--production-only') && env.VERCEL_ENV && env.VERCEL_ENV !== 'production') {
    return { run: false, reason: `Migraciones omitidas: este build es de «${env.VERCEL_ENV}» y comparte la base de producción. Se aplican al fusionar.` };
  }
  return { run: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const policy = migrationPolicy(process.argv, process.env);
  if (!policy.run) {
    console.log(policy.reason);
    process.exit(0);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.argv.includes('--if-configured')) {
      console.log('DATABASE_URL no está configurada: se omiten las migraciones.');
      process.exit(0);
    }
    console.error('Falta DATABASE_URL.');
    process.exit(1);
  }
  migrate(getDb(url), console.log)
    .then(a => console.log(a.length ? `${a.length} migraciones aplicadas.` : 'Base de datos al día.'))
    .catch(e => { console.error('Error al migrar:', e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(() => closeAllDbs());
}
