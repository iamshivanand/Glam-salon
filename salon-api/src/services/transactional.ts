import { decrypt } from '../crypto.js';
import { one, query } from '../db.js';
import { env } from '../env.js';
import { incrementMetric } from '../metrics.js';
import { notifier, type NotificationChannel, type NotificationResult } from './notifications.js';
import {
  renderTransactional,
  type TemplateContext,
  type TransactionalTemplate,
} from './rendering.js';

export { renderTransactional };
export type { TemplateContext, TransactionalTemplate };

interface Recipient {
  id: string;
  full_name: string;
  phone_e164_encrypted: Buffer;
  email: string | null;
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain ?? ''}`;
}

async function recipientFor(userId: string): Promise<Recipient | null> {
  const row = await one<Recipient>(
    `SELECT id, full_name, phone_e164_encrypted, email
       FROM users WHERE id = $1 AND status = 'ACTIVE'`,
    [userId],
  );
  return row;
}

function contactFor(recipient: Recipient, channel: NotificationChannel): string | null {
  if (channel === 'EMAIL') return recipient.email;
  if (channel === 'PUSH') return null; // push is resolved per device token
  try {
    return decrypt(recipient.phone_e164_encrypted);
  } catch {
    return null;
  }
}

function preferredChannels(): NotificationChannel[] {
  const configured = notifier.describe();
  const candidates: NotificationChannel[] = [];
  if (env.TRANSACTIONAL_CHANNEL === 'EMAIL') candidates.push('EMAIL');
  if (env.TRANSACTIONAL_CHANNEL === 'WHATSAPP') candidates.push('WHATSAPP');
  if (env.TRANSACTIONAL_CHANNEL === 'SMS') candidates.push('SMS');
  // Fall back to any configured channel so a missing email does not silence
  // a booking confirmation.
  for (const channel of ['WHATSAPP', 'SMS', 'EMAIL'] as NotificationChannel[]) {
    if (!candidates.includes(channel)) candidates.push(channel);
  }
  return candidates.filter((channel) => configured[channel] !== 'none');
}

async function transactionalConsentRevoked(userId: string, salonId: string, channel: NotificationChannel): Promise<boolean> {
  const row = await one<{ revoked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM customer_consents
        WHERE user_id = $1
          AND channel = $3
          AND purpose = 'BOOKING_TRANSACTIONAL'
          AND is_granted = FALSE
          AND (salon_id = $2 OR salon_id IS NULL)
     ) AS revoked`,
    [userId, salonId, channel],
  );
  return row?.revoked ?? false;
}

export interface TransactionalInput {
  template: TransactionalTemplate;
  userId: string;
  salonId: string;
  data?: Record<string, unknown>;
  context: TemplateContext;
  channel?: NotificationChannel;
}

/**
 * Best-effort transactional send. Callers should not await this on the critical
 * path; failures are logged to notification_log and never break a booking.
 */
export async function sendTransactional(input: TransactionalInput): Promise<NotificationResult | null> {
  const recipient = await recipientFor(input.userId);
  if (!recipient) return null;

  const rendered = renderTransactional(input.template, input.context);
  const channels = input.channel ? [input.channel] : preferredChannels();

  for (const channel of channels) {
    if (await transactionalConsentRevoked(input.userId, input.salonId, channel)) continue;

    if (channel === 'PUSH') {
      const tokens = await query<{ token: string }>(
        `SELECT token FROM device_push_tokens WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 5`,
        [input.userId],
      );
      for (const { token } of tokens) {
        try {
          return await notifier.send({
            channel: 'PUSH',
            to: token,
            subject: rendered.subject,
            text: rendered.text,
            template: input.template,
            userId: input.userId,
            salonId: input.salonId,
            data: { ...(input.data ?? {}), params: rendered.params },
          });
        } catch {
          // Try the next token, then fall through to another channel.
        }
      }
      continue;
    }

    const to = contactFor(recipient, channel);
    if (!to) continue;
    try {
      return await notifier.send({
        channel,
        to,
        subject: rendered.subject,
        text: rendered.text,
        template: input.template,
        userId: input.userId,
        salonId: input.salonId,
        data: { ...(input.data ?? {}), params: rendered.params },
      });
    } catch (err) {
      incrementMetric('glamconnect_transactional_failed_total');
      console.warn(
        `[transactional] ${input.template} via ${channel} to ${channel === 'EMAIL' ? maskEmail(to) : 'phone'} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return null;
}

/** Fire-and-forget helper for request paths that must not block on providers. */
export function queueTransactional(input: TransactionalInput): void {
  void sendTransactional(input).catch((err) => {
    console.warn('[transactional] dispatch failed', err instanceof Error ? err.message : err);
  });
}
