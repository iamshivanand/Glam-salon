import { decrypt, randomToken } from '../crypto.js';
import { one, query, withTenant } from '../db.js';
import { env } from '../env.js';
import { redis } from '../redis.js';
import {
  NotificationError,
  notifier as defaultNotifier,
  type NotificationChannel,
  type Notifier,
} from './notifications.js';

export interface DispatchLog {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface DispatchResult {
  due: number;
  sent: number;
  suppressed: number;
  failed: number;
  skipped: number;
}

interface DueReminder {
  id: string;
  salon_id: string;
  customer_id: string;
  channel: NotificationChannel;
  template_code: string;
  deep_link_token: string;
  delivery_attempts: number;
  salon_name: string;
  category_name: string;
  customer_name: string;
  phone_e164_encrypted: Buffer | null;
  email: string | null;
}

const LOCK_TTL_SEC = 180;

function logError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

function destinationFor(row: DueReminder): string | null {
  if (row.channel === 'EMAIL') return row.email;
  if (row.channel === 'PUSH') return `customer:${row.customer_id}`;
  if (!row.phone_e164_encrypted) return null;
  try {
    return decrypt(row.phone_e164_encrypted);
  } catch {
    return null;
  }
}

export function renderReminder(row: DueReminder): { subject: string; text: string } {
  const firstName = row.customer_name.split(' ')[0] || 'there';
  const base = env.APP_PUBLIC_URL.replace(/\/$/, '');
  const link = `${base}/book?salon=${row.salon_id}&ref=${row.deep_link_token}`;
  const service = row.category_name.toLowerCase();

  switch (row.template_code) {
    case 'DAY_20_GENTLE':
      return {
        subject: `${firstName}, your ${service} is coming up`,
        text: `Hi ${firstName}, it's almost time for your next ${service} at ${row.salon_name}. Pick a slot that suits you: ${link}`,
      };
    case 'DAY_25_INVITE':
      return {
        subject: `${firstName}, book your ${service} at ${row.salon_name}`,
        text: `Hi ${firstName}, your ${service} at ${row.salon_name} is due around now. Reserve your preferred time: ${link}`,
      };
    case 'DAY_35_REENGAGE':
      return {
        subject: `We miss you at ${row.salon_name}`,
        text: `Hi ${firstName}, it has been a while since your last ${service} at ${row.salon_name}. Treat yourself and book again: ${link}`,
      };
    default:
      return {
        subject: `A note from ${row.salon_name}`,
        text: `Hi ${firstName}, ${row.salon_name} would love to see you again. Book your next visit: ${link}`,
      };
  }
}

async function markSuppressed(salonId: string, id: string): Promise<void> {
  await withTenant(salonId, async (client) => {
    await client.query(
      `UPDATE retention_reminders
          SET status = 'SUPPRESSED_OPT_OUT', next_attempt_at = NULL
        WHERE id = $1`,
      [id],
    );
  });
}

async function markSent(
  salonId: string,
  id: string,
  provider: string,
  messageId: string | null,
): Promise<void> {
  await withTenant(salonId, async (client) => {
    await client.query(
      `UPDATE retention_reminders
          SET status = 'SENT',
              sent_at = NOW(),
              provider_message_id = $2,
              delivery_attempts = delivery_attempts + 1,
              last_error = NULL,
              next_attempt_at = NULL
        WHERE id = $1`,
      [id, messageId ?? provider],
    );
  });
}

async function markAttemptFailed(row: DueReminder, error: string): Promise<'retry' | 'failed'> {
  const attempts = row.delivery_attempts + 1;
  if (attempts >= env.REMINDER_MAX_ATTEMPTS) {
    await withTenant(row.salon_id, async (client) => {
      await client.query(
        `UPDATE retention_reminders
            SET status = 'FAILED',
                delivery_attempts = $2,
                last_error = $3,
                next_attempt_at = NULL
          WHERE id = $1`,
        [row.id, attempts, error],
      );
    });
    return 'failed';
  }

  const nextAttempt = new Date(Date.now() + attempts * 5 * 60_000);
  await withTenant(row.salon_id, async (client) => {
    await client.query(
      `UPDATE retention_reminders
          SET delivery_attempts = $2,
              last_error = $3,
              next_attempt_at = $4
        WHERE id = $1`,
      [row.id, attempts, error, nextAttempt],
    );
  });
  return 'retry';
}

/** Read due reminders for one salon. retention_reminders is FORCE-RLS. */
async function dueReminders(
  salonId: string,
  ids: string[] | null,
  limit: number,
): Promise<DueReminder[]> {
  return withTenant(salonId, async (client) => {
    const res = await client.query<DueReminder>(
      `SELECT r.id, r.salon_id, r.customer_id, r.channel, r.template_code, r.deep_link_token,
              r.delivery_attempts,
              s.name AS salon_name,
              sc.name AS category_name,
              u.full_name AS customer_name,
              u.phone_e164_encrypted,
              u.email
         FROM retention_reminders r
         JOIN salons s ON s.id = r.salon_id
         JOIN service_categories sc ON sc.id = r.service_category_id
         JOIN users u ON u.id = r.customer_id
        WHERE r.salon_id = $1
          AND r.status = 'SCHEDULED'
          AND r.scheduled_for <= NOW()
          AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= NOW())
          AND ($2::uuid[] IS NULL OR r.id = ANY($2::uuid[]))
        ORDER BY r.scheduled_for
        LIMIT $3`,
      [salonId, ids, limit],
    );
    return res.rows;
  });
}

/**
 * Deliver due retention reminders.
 *
 * A Redis lock per reminder prevents duplicate sends when more than one API
 * instance runs the dispatcher. Delivery is at-least-once: a crash between the
 * provider accepting the message and the DB update can resend after the lock
 * expires, which is preferable to silently dropping a reminder.
 */
export async function dispatchReminders(
  opts: {
    ids?: string[];
    salonId?: string;
    limit?: number;
    notifierInstance?: Notifier;
    log?: DispatchLog;
  } = {},
): Promise<DispatchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const ids = opts.ids?.length ? opts.ids : null;
  const notifier = opts.notifierInstance ?? defaultNotifier;

  // retention_reminders is protected by FORCE RLS, so the dispatcher has to read
  // and write one tenant at a time. A global sweep walks every salon.
  const salonIds = opts.salonId
    ? [opts.salonId]
    : (await query<{ id: string }>(`SELECT id FROM salons ORDER BY created_at`)).map((r) => r.id);

  const rows: DueReminder[] = [];
  for (const salonId of salonIds) {
    if (rows.length >= limit) break;
    rows.push(...(await dueReminders(salonId, ids, limit - rows.length)));
  }

  const result: DispatchResult = {
    due: rows.length,
    sent: 0,
    suppressed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of rows) {
    const lockKey = `reminder:dispatch:${row.id}`;
    const lockToken = randomToken(8);
    const acquired = await redis.set(lockKey, lockToken, 'EX', LOCK_TTL_SEC, 'NX');
    if (!acquired) {
      result.skipped += 1;
      continue;
    }

    try {
      const consent = await one<{ is_granted: boolean }>(
        `SELECT is_granted FROM customer_consents
          WHERE user_id = $1 AND salon_id = $2 AND channel = $3 AND purpose = 'RETENTION_REMINDER'
          LIMIT 1`,
        [row.customer_id, row.salon_id, row.channel],
      );
      if (!consent?.is_granted) {
        await markSuppressed(row.salon_id, row.id);
        result.suppressed += 1;
        opts.log?.info({ reminderId: row.id, channel: row.channel }, 'reminder suppressed: no consent');
        continue;
      }

      const to = destinationFor(row);
      if (!to) {
        throw new NotificationError('NO_DESTINATION', `No ${row.channel} destination on file`);
      }

      const { subject, text } = renderReminder(row);
      const delivery = await notifier.send({
        channel: row.channel,
        to,
        subject,
        text,
        template: row.template_code,
        data: { reminder_id: row.id, salon_id: row.salon_id },
      });
      await markSent(row.salon_id, row.id, delivery.provider, delivery.messageId);
      result.sent += 1;
      opts.log?.info(
        { reminderId: row.id, channel: row.channel, provider: delivery.provider },
        'reminder sent',
      );
    } catch (err) {
      const error = logError(err);
      const outcome = await markAttemptFailed(row, error);
      if (outcome === 'failed') result.failed += 1;
      opts.log?.warn(
        { reminderId: row.id, channel: row.channel, outcome, error },
        'reminder delivery attempt failed',
      );
    } finally {
      await redis
        .eval(
          `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
          1,
          lockKey,
          lockToken,
        )
        .catch(() => undefined);
    }
  }

  return result;
}

/** In-process interval dispatcher. Disable it to run `npm run dispatch` from cron instead. */
export function startReminderDispatcher(log: DispatchLog, intervalSec = env.REMINDER_DISPATCH_INTERVAL_SEC) {
  if ((env.REMINDER_DISPATCH_ENABLED ?? 'true') === 'false') {
    log.info({}, 'reminder dispatcher disabled by REMINDER_DISPATCH_ENABLED=false');
    return () => undefined;
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await dispatchReminders({ limit: 50, log });
      if (result.due) log.info(result, 'reminder dispatcher tick');
    } catch (err) {
      log.error({ error: logError(err) }, 'reminder dispatcher tick failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalSec * 1000);
  timer.unref?.();
  log.info({ intervalSec }, 'reminder dispatcher started');
  return () => clearInterval(timer);
}
