/**
 * One-shot reminder dispatcher for cron / scheduled jobs.
 *   npm run dispatch            # deliver up to 50 due reminders
 *   npm run dispatch -- 100     # custom batch size
 */
import 'dotenv/config';
import { dispatchReminders } from '../src/services/dispatcher.js';
import { closeDb } from '../src/db.js';
import { closeRedis } from '../src/redis.js';

const limit = Number(process.argv[2] ?? 50);
const log = {
  info: (obj: object, msg?: string) => console.log(msg ?? 'info', obj),
  warn: (obj: object, msg?: string) => console.warn(msg ?? 'warn', obj),
  error: (obj: object, msg?: string) => console.error(msg ?? 'error', obj),
};

try {
  const result = await dispatchReminders({ limit, log });
  console.log(JSON.stringify(result));
  process.exitCode = result.failed ? 1 : 0;
} catch (err) {
  console.error('dispatch failed', err);
  process.exitCode = 1;
} finally {
  await closeDb();
  await closeRedis();
}
