/**
 * The Postgres connection and the migration runner.
 *
 * The database is optional: with no DATABASE_URL the game runs exactly the
 * same, it just doesn't save anything. That keeps tests and quick local runs
 * free of Docker.
 */
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.DATABASE_URL;

export let pool: pg.Pool | null = url ? new pg.Pool({ connectionString: url, max: 5 }) : null;

// An idle connection dropping (database restarted) must not crash the server.
pool?.on('error', (error) => console.error('[db] idle connection error:', error.message));

/** Test seam: point everything at an in-memory database instead. */
export function usePool(replacement: pg.Pool | null): void {
  pool = replacement;
}

const MIGRATIONS = new URL('../../database/migrations/', import.meta.url);

/**
 * Apply every migration in database/migrations that hasn't run yet, in file
 * name order, each in its own transaction.
 *
 * ponytail: a 30-line runner instead of a migration library. Plain numbered
 * SQL files; reach for a library only if we ever need down-migrations.
 */
export async function migrate(): Promise<void> {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));
  const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, MIGRATIONS), 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[db] applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
}
