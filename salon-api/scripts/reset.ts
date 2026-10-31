import 'dotenv/config';
import pg from 'pg';

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATE_DATABASE_URL or DATABASE_URL must be set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query('DROP SCHEMA IF EXISTS public CASCADE');
await client.query('CREATE SCHEMA public');
await client.query('GRANT ALL ON SCHEMA public TO public');
console.log('Schema public reset (tables, types, extensions dropped).');

await client.end();
console.log('\nNow run: npm run migrate');
console.log('Then run: npm run seed');
