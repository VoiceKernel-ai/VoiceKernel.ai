/**
 * Forward-only SQL migration runner.
 *
 * Files in db/ are applied in filename order inside a transaction each, and
 * recorded in schema_migrations. A file whose checksum changed after being
 * applied is a hard error: silently re-running an edited migration is how
 * environments drift apart.
 *
 *   npm run migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool, closePool } from '../src/db';

/**
 * Locates the migrations directory.
 *
 * Under tsx this file runs from scripts/, but the compiled build runs from
 * dist/scripts/ - so a single `../db` is right in development and wrong in the
 * container, where it resolves to dist/db and the runner exits claiming there
 * are no migrations. Probing the candidates keeps both layouts working.
 */
function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(__dirname, '../db'), // scripts/migrate.ts      -> ./db
    path.resolve(__dirname, '../../db'), // dist/scripts/migrate.js -> ./db
    path.resolve(process.cwd(), 'db'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate the db/ migrations directory. Looked in:\n  ${candidates.join('\n  ')}`);
}

const MIGRATIONS_DIR = resolveMigrationsDir();

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function main(): Promise<void> {
  await ensureMigrationsTable();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRows = await pool.query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM schema_migrations`,
  );
  const applied = new Map(appliedRows.rows.map((r) => [r.filename, r.checksum]));

  let ran = 0;

  for (const filename of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(filename);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${filename} was modified after it was applied.\n` +
            `Migrations are immutable - add a new file instead of editing this one.`,
        );
      }
      continue;
    }

    process.stdout.write(`  applying ${filename} … `);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
        [filename, checksum],
      );
      await client.query('COMMIT');
      process.stdout.write('ok\n');
      ran++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      process.stdout.write('failed\n');
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(
    ran === 0
      ? `Database is up to date (${files.length} migration(s) already applied).`
      : `Applied ${ran} migration(s).`,
  );
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('\nMigration failed:\n', err instanceof Error ? err.message : err);
    await closePool().catch(() => {});
    process.exit(1);
  });
