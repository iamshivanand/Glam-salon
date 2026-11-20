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
import { renderReminderMessage } from './rendering.js';
import { expireStaleBookings } from './booking.js';

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
  if (row.channel === 'PUSH') return null; // resolved from device_push_tokens
  if (!row.phone_e164_encrypted) return null;
  try {
    return decrypt(row.phone_e164_encrypted);
  } catch {
    return null;
  }
}

async function pushTokens(userId: string): Promise<string[]> {
  const rows = await query<{ token: string }>(
    `SELECT token FROM device_push_tokens WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 5`,
    [userId],
  );
  return rows.map((r) => r.token);
}

export function renderReminder(row: DueReminder): { subject: string; text: string } {
  return renderReminderMessage(row, env.API_PUBLIC_URL);
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
              provider = $3,
              provider_message_id = $2,
              delivery_attempts = delivery_attempts + 1,
              last_error = NULL,
              next_attempt_at = NULL
        WHERE id = $1`,
      [id, messageId, provider],
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
      const consent = await one<{ revoked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM customer_consents
            WHERE user_id = $1
              AND channel = $3
              AND purpose = 'RETENTION_REMINDER'
              AND is_granted = FALSE
              AND (salon_id = $2 OR salon_id IS NULL)
         ) AS revoked`,
        [row.customer_id, row.salon_id, row.channel],
      );
      if (consent?.revoked) {
        await markSuppressed(row.salon_id, row.id);
        result.suppressed += 1;
        opts.log?.info({ reminderId: row.id, channel: row.channel }, 'reminder suppressed: no consent');
        continue;
      }

      const { subject, text } = renderReminder(row);
      let delivery: { provider: string; messageId: string | null } | null = null;

      if (row.channel === 'PUSH') {
        const tokens = await pushTokens(row.customer_id);
        if (!tokens.length) {
          throw new NotificationError('NO_DESTINATION', 'No push device token on file');
        }
        for (const token of tokens) {
          const sent = await notifier.send({
            channel: 'PUSH',
            to: token,
            subject,
            text,
            template: row.template_code,
            userId: row.customer_id,
            salonId: row.salon_id,
            data: { reminder_id: row.id, salon_id: row.salon_id, deep_link_token: row.deep_link_token },
          });
          delivery ??= sent;
        }
      } else {
        const to = destinationFor(row);
        if (!to) {
          throw new NotificationError('NO_DESTINATION', `No ${row.channel} destination on file`);
        }
        delivery = await notifier.send({
          channel: row.channel,
          to,
          subject,
          text,
          template: row.template_code,
          userId: row.customer_id,
          salonId: row.salon_id,
          data: { reminder_id: row.id, salon_id: row.salon_id, deep_link_token: row.deep_link_token },
        });
      }

      if (!delivery) throw new NotificationError('NO_PROVIDER', 'Push delivery produced no result');
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
      await expireStaleBookings().catch((err) => log.error({ error: logError(err) }, 'expireStaleBookings failed'));
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
