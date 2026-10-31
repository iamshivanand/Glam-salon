import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATE_DATABASE_URL or DATABASE_URL must be set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

const dir = path.join(process.cwd(), 'db', 'migrations');
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

let applied = 0;
for (const file of files) {
  const seen = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
  if (seen.rowCount) {
    console.log(`= ${file} (already applied)`);
    continue;
  }
  const sql = await fs.readFile(path.join(dir, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
    applied += 1;
    console.log(`+ ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`x ${file} failed`);
    throw err;
  }
}

await client.end();
console.log(`\nMigrations complete (${applied} applied, ${files.length} total).`);
