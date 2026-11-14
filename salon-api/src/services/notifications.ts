import { allowConsoleNotifications, env } from '../env.js';
import { maskPhone, randomToken } from '../crypto.js';
import { query } from '../db.js';
import { incrementMetric } from '../metrics.js';

export type NotificationChannel = 'SMS' | 'WHATSAPP' | 'EMAIL' | 'PUSH';

export interface NotificationMessage {
  channel: NotificationChannel;
  /** Phone in E.164, email address, or push token. */
  to: string;
  text: string;
  subject?: string;
  template?: string;
  data?: Record<string, unknown>;
  userId?: string;
  salonId?: string;
}

export interface NotificationResult {
  provider: string;
  messageId: string | null;
}

export interface NotificationProvider {
  name: string;
  channels: NotificationChannel[];
  send(message: NotificationMessage): Promise<NotificationResult>;
}

export class NotificationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

const ALL_CHANNELS: NotificationChannel[] = ['SMS', 'WHATSAPP', 'EMAIL', 'PUSH'];

export function maskDestination(channel: NotificationChannel, to: string): string {
  if (channel === 'EMAIL') {
    const [name, domain] = to.split('@');
    return `${name.slice(0, 2)}***@${domain ?? ''}`;
  }
  if (channel === 'PUSH') return to.length > 12 ? `${to.slice(0, 6)}…${to.slice(-4)}` : to;
  return maskPhone(to);
}

function templateMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

function templateParams(message: NotificationMessage): string[] {
  const params = message.data?.params;
  if (!Array.isArray(params)) return [];
  return params.map((p) => String(p));
}

/**
 * Development / CI provider. It still goes through the same routing and dispatch
 * code as real providers, but prints the message instead of calling a vendor.
 */
export class ConsoleProvider implements NotificationProvider {
  name = 'console';
  channels = ALL_CHANNELS;

  async send(message: NotificationMessage): Promise<NotificationResult> {
    const oneLine = message.text.replace(/\s+/g, ' ').slice(0, 200);
    console.log(
      `[notify:console] ${message.channel} -> ${maskDestination(message.channel, message.to)} :: ${oneLine}`,
    );
    return { provider: this.name, messageId: `console-${randomToken(6)}` };
  }
}

/** Generic adapter for an internal notification service or automation platform. */
export class WebhookProvider implements NotificationProvider {
  name = 'webhook';
  channels = ALL_CHANNELS;

  async send(message: NotificationMessage): Promise<NotificationResult> {
    if (!env.NOTIFY_WEBHOOK_URL) {
      throw new NotificationError('NOT_CONFIGURED', 'NOTIFY_WEBHOOK_URL is not set');
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.NOTIFY_WEBHOOK_SECRET) headers['X-Notify-Secret'] = env.NOTIFY_WEBHOOK_SECRET;

    let res: Response;
    try {
      res = await fetch(env.NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...message, destination: message.to }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new NotificationError('PROVIDER_UNREACHABLE', `Webhook request failed: ${String(err)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new NotificationError('PROVIDER_HTTP_ERROR', `Webhook responded ${res.status} ${body.slice(0, 180)}`);
    }
    let messageId: string | null = null;
    try {
      const json = (await res.json()) as { id?: string; message_id?: string };
      messageId = json.id ?? json.message_id ?? null;
    } catch {
      // A 2xx without a JSON body is still a successful hand-off.
    }
    return { provider: this.name, messageId };
  }
}

/**
 * Twilio adapter. SMS and WhatsApp use the same Messages API but different
 * From/To prefixes. When a ContentSid is configured for the template, the
 * message is sent through Twilio's Content API so WhatsApp template rules apply.
 */
export class TwilioProvider implements NotificationProvider {
  name = 'twilio';
  channels: NotificationChannel[];
  private from: string;
  private kind: 'SMS' | 'WHATSAPP';

  constructor(kind: 'SMS' | 'WHATSAPP', from: string) {
    this.kind = kind;
    this.from = from;
    this.channels = [kind];
  }

  async send(message: NotificationMessage): Promise<NotificationResult> {
    const sid = env.TWILIO_ACCOUNT_SID;
    const token = env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new NotificationError('NOT_CONFIGURED', 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
    }

    const to = this.kind === 'WHATSAPP' ? `whatsapp:${message.to}` : message.to;
    const from = this.kind === 'WHATSAPP' ? `whatsapp:${this.from}` : this.from;
    const body = new URLSearchParams({ To: to, From: from });
    const contentSid = message.template ? templateMap(env.TWILIO_CONTENT_SID_MAP)[message.template] : undefined;
    if (contentSid) {
      const params = templateParams(message);
      body.set('ContentSid', contentSid);
      if (params.length) {
        body.set('ContentVariables', JSON.stringify(Object.fromEntries(params.map((p, i) => [String(i + 1), p]))));
      }
      if (message.text) body.set('Body', message.text.slice(0, 1024));
    } else {
      body.set('Body', message.text);
    }

    let res: Response;
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new NotificationError('PROVIDER_UNREACHABLE', `Twilio request failed: ${String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new NotificationError('PROVIDER_HTTP_ERROR', `Twilio responded ${res.status} ${text.slice(0, 180)}`);
    }
    const json = (await res.json()) as { sid?: string };
    return { provider: this.name, messageId: json.sid ?? null };
  }
}

/**
 * Meta WhatsApp Cloud API adapter. Business-initiated messages use approved
 * templates when WHATSAPP_TEMPLATES_ENABLED=true and a template name is mapped.
 */
export class WhatsAppCloudProvider implements NotificationProvider {
  name = 'whatsapp_cloud';
  channels: NotificationChannel[] = ['WHATSAPP'];

  async send(message: NotificationMessage): Promise<NotificationResult> {
    const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
    const token = env.WHATSAPP_ACCESS_TOKEN;
    if (!phoneNumberId || !token) {
      throw new NotificationError(
        'NOT_CONFIGURED',
        'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are required',
      );
    }

    const templatesEnabled = (env.WHATSAPP_TEMPLATES_ENABLED ?? 'false') === 'true';
    const templateName = message.template ? templateMap(env.WHATSAPP_TEMPLATE_MAP)[message.template] : undefined;
    const useTemplate = templatesEnabled && Boolean(templateName);

    const payload = useTemplate
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: message.to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: templateName,
            language: { code: 'en' },
            components: templateParams(message).length
              ? [
                  {
                    type: 'body',
                    parameters: templateParams(message).map((text) => ({ type: 'text', text })),
                  },
                ]
              : [],
          },
        }
      : {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: message.to.replace(/^\+/, ''),
          type: 'text',
          text: { preview_url: true, body: message.text },
        };

    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new NotificationError('PROVIDER_UNREACHABLE', `WhatsApp Cloud request failed: ${String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new NotificationError(
        'PROVIDER_HTTP_ERROR',
        `WhatsApp Cloud responded ${res.status} ${text.slice(0, 180)}`,
      );
    }
    const json = (await res.json()) as { messages?: { id?: string }[] };
    return { provider: this.name, messageId: json.messages?.[0]?.id ?? null };
  }
}

/** Resend transactional email adapter. */
export class ResendProvider implements NotificationProvider {
  name = 'resend';
  channels: NotificationChannel[] = ['EMAIL'];

  async send(message: NotificationMessage): Promise<NotificationResult> {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
      throw new NotificationError('NOT_CONFIGURED', 'RESEND_API_KEY and RESEND_FROM are required');
    }

    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.RESEND_FROM,
          to: [message.to],
          subject: message.subject ?? 'Glam Connect',
          text: message.text,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new NotificationError('PROVIDER_UNREACHABLE', `Resend request failed: ${String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new NotificationError('PROVIDER_HTTP_ERROR', `Resend responded ${res.status} ${text.slice(0, 180)}`);
    }
    const json = (await res.json()) as { id?: string };
    return { provider: this.name, messageId: json.id ?? null };
  }
}

/** Expo push adapter. `to` is an Expo push token (`ExponentPushToken[...]`). */
export class ExpoPushProvider implements NotificationProvider {
  name = 'expo';
  channels: NotificationChannel[] = ['PUSH'];

  async send(message: NotificationMessage): Promise<NotificationResult> {
    let res: Response;
    try {
      res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          to: message.to,
          title: message.subject ?? 'Glam Connect',
          body: message.text,
          data: { ...(message.data ?? {}), template: message.template },
          sound: 'default',
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new NotificationError('PROVIDER_UNREACHABLE', `Expo push request failed: ${String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new NotificationError('PROVIDER_HTTP_ERROR', `Expo push responded ${res.status} ${text.slice(0, 180)}`);
    }
    const json = (await res.json()) as { data?: { id?: string; status?: string } };
    if (json.data?.status === 'error') {
      throw new NotificationError('PROVIDER_REJECTED', 'Expo push rejected the message');
    }
    return { provider: this.name, messageId: json.data?.id ?? null };
  }
}

async function logDelivery(
  message: NotificationMessage,
  result: NotificationResult | null,
  error: string | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO notification_log
         (user_id, salon_id, channel, template_code, destination_masked,
          provider, provider_message_id, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        message.userId ?? null,
        message.salonId ?? null,
        message.channel,
        message.template ?? null,
        maskDestination(message.channel, message.to),
        result?.provider ?? null,
        result?.messageId ?? null,
        error ? 'FAILED' : 'SENT',
        error,
      ],
    );
  } catch {
    // Logging must never mask a delivery failure or break a request.
  }
}

export class Notifier {
  constructor(
    private routes: Partial<Record<NotificationChannel, NotificationProvider>>,
    private fallback?: NotificationProvider,
  ) {}

  private resolve(channel: NotificationChannel): NotificationProvider | undefined {
    return this.routes[channel] ?? this.fallback;
  }

  async send(message: NotificationMessage): Promise<NotificationResult> {
    const provider = this.resolve(message.channel);
    if (!provider) {
      throw new NotificationError(
        'NO_PROVIDER',
        `No ${message.channel} notification provider is configured`,
      );
    }
    try {
      const result = await provider.send(message);
      incrementMetric(`glamconnect_notifications_sent_total`);
      incrementMetric(`glamconnect_notifications_${message.channel.toLowerCase()}_sent_total`);
      await logDelivery(message, result, null);
      return result;
    } catch (err) {
      incrementMetric('glamconnect_notifications_failed_total');
      await logDelivery(message, null, err instanceof Error ? err.message.slice(0, 500) : String(err));
      throw err;
    }
  }

  describe(): Record<NotificationChannel, string> {
    return Object.fromEntries(
      ALL_CHANNELS.map((channel) => [channel, this.resolve(channel)?.name ?? 'none']),
    ) as Record<NotificationChannel, string>;
  }
}

function buildNotifier(): Notifier {
  const explicit = env.NOTIFICATION_PROVIDER;

  if (explicit === 'console') {
    if (!allowConsoleNotifications) {
      throw new Error(
        'NOTIFICATION_PROVIDER=console is not allowed in production. Configure a real provider or set ALLOW_CONSOLE_NOTIFICATIONS=true.',
      );
    }
    return new Notifier({}, new ConsoleProvider());
  }

  const routes: Partial<Record<NotificationChannel, NotificationProvider>> = {};
  const add = (provider: NotificationProvider) => {
    for (const channel of provider.channels) routes[channel] ??= provider;
  };

  if (explicit === 'webhook') {
    if (!env.NOTIFY_WEBHOOK_URL) throw new Error('NOTIFICATION_PROVIDER=webhook requires NOTIFY_WEBHOOK_URL');
    add(new WebhookProvider());
  } else if (explicit === 'twilio') {
    if (!env.TWILIO_SMS_FROM && !env.TWILIO_WHATSAPP_FROM) {
      throw new Error('NOTIFICATION_PROVIDER=twilio requires TWILIO_SMS_FROM or TWILIO_WHATSAPP_FROM');
    }
    if (env.TWILIO_SMS_FROM) add(new TwilioProvider('SMS', env.TWILIO_SMS_FROM));
    if (env.TWILIO_WHATSAPP_FROM) add(new TwilioProvider('WHATSAPP', env.TWILIO_WHATSAPP_FROM));
  } else if (explicit === 'whatsapp_cloud') {
    if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
      throw new Error(
        'NOTIFICATION_PROVIDER=whatsapp_cloud requires WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN',
      );
    }
    add(new WhatsAppCloudProvider());
  } else if (explicit === 'resend') {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
      throw new Error('NOTIFICATION_PROVIDER=resend requires RESEND_API_KEY and RESEND_FROM');
    }
    add(new ResendProvider());
  } else {
    // auto: wire every provider that has credentials, most specific first.
    const hasTwilio = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
    if (hasTwilio && env.TWILIO_SMS_FROM) add(new TwilioProvider('SMS', env.TWILIO_SMS_FROM));
    if (env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN) add(new WhatsAppCloudProvider());
    if (hasTwilio && env.TWILIO_WHATSAPP_FROM) add(new TwilioProvider('WHATSAPP', env.TWILIO_WHATSAPP_FROM));
    if (env.RESEND_API_KEY && env.RESEND_FROM) add(new ResendProvider());
    if (env.NOTIFY_WEBHOOK_URL) add(new WebhookProvider());
    // Expo push has no credentials gate; it only fires when a device token exists.
    if (!routes.PUSH) add(new ExpoPushProvider());
  }

  const fallback = allowConsoleNotifications ? new ConsoleProvider() : undefined;
  if (!fallback && Object.keys(routes).length === 0) {
    throw new Error(
      'No notification provider configured. Set Twilio, WhatsApp Cloud, Resend or NOTIFY_WEBHOOK_URL credentials.',
    );
  }
  return new Notifier(routes, fallback);
}

export const notifier = buildNotifier();

export async function sendOtpCode(phone: string, code: string): Promise<NotificationResult> {
  return notifier.send({
    channel: env.OTP_CHANNEL,
    to: phone,
    template: 'OTP_V1',
    text: `Glam Connect: ${code} is your verification code. It expires in 5 minutes. Never share this code.`,
    data: { params: [code] },
  });
}
