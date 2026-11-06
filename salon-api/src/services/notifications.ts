import { allowConsoleNotifications, env } from '../env.js';
import { maskPhone, randomToken } from '../crypto.js';

export type NotificationChannel = 'SMS' | 'WHATSAPP' | 'EMAIL' | 'PUSH';

export interface NotificationMessage {
  channel: NotificationChannel;
  /** Phone in E.164, email address, or customer id for PUSH webhooks. */
  to: string;
  text: string;
  subject?: string;
  template?: string;
  data?: Record<string, unknown>;
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

function maskDestination(channel: NotificationChannel, to: string): string {
  if (channel === 'EMAIL') {
    const [name, domain] = to.split('@');
    return `${name.slice(0, 2)}***@${domain ?? ''}`;
  }
  if (channel === 'PUSH') return to;
  return maskPhone(to);
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
 * From/To prefixes. WhatsApp outside a user-initiated window requires an approved
 * template on Twilio's side; this adapter sends the plain body we compose.
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
    const body = new URLSearchParams({ To: to, From: from, Body: message.text });

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

/** Meta WhatsApp Cloud API adapter (text messages). */
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

    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: message.to.replace(/^\+/, ''),
          type: 'text',
          text: { preview_url: false, body: message.text },
        }),
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
    return provider.send(message);
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
  });
}
