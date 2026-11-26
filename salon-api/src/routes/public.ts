import type { FastifyPluginAsync } from 'fastify';
import { env } from '../env.js';
import { incrementMetric } from '../metrics.js';
import { applyDeliveryEvent, isOptOutMessage, recordOptOut, recordReminderClick } from '../services/engagement.js';
import { applyRazorpayWebhook } from '../services/payments.js';
import { verifyHmacSha256, verifyTwilioSignature } from '../services/signatures.js';

function twilioStatusToEvent(status: unknown): string | null {
  switch (String(status ?? '').toLowerCase()) {
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'failed':
    case 'undelivered':
      return 'FAILED';
    default:
      return null;
  }
}

function metaStatusToEvent(status: unknown): string | null {
  switch (String(status ?? '').toLowerCase()) {
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'failed':
      return 'FAILED';
    default:
      return null;
  }
}

function stripWhatsAppPrefix(value: string): string {
  return value.replace(/^whatsapp:/i, '');
}

/**
 * Public, unauthenticated endpoints:
 *  - click redirects for reminder messages
 *  - inbound provider callbacks and opt-outs
 *
 * These are registered at the server root (not under /api/v1) because the URLs
 * are handed to third-party providers. Every mutating callback verifies a
 * provider signature before touching data.
 */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  // The JSON parser (with rawBody for provider HMACs) is registered globally in
  // index.ts. Only form payloads still need their own parser here.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as any).rawBody = body;
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  // ---------- Reminder click tracking ----------
  app.get('/r/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const base = env.APP_PUBLIC_URL.replace(/\/$/, '');

    try {
      const result = await recordReminderClick(token);
      if (result) {
        return reply.redirect(
          `${base}/book?salon=${encodeURIComponent(result.reminder.salon_id)}&ref=${encodeURIComponent(token)}`,
          302,
        );
      }
    } catch (err) {
      req.log.warn({ err, token }, 'reminder click tracking failed');
    }
    // Still honour the link even if tracking failed: send the customer home.
    return reply.redirect(base, 302);
  });

  // ---------- Twilio status + inbound SMS/WhatsApp ----------
  const twilioHandler = async (req: any, reply: any) => {
    const authToken = env.TWILIO_AUTH_TOKEN;
    const form = (req.body ?? {}) as Record<string, string>;
    const callbackUrl = `${env.API_PUBLIC_URL.replace(/\/$/, '')}${req.raw.url ?? req.url}`;
    const signature = req.headers['x-twilio-signature'];
    const isDev = env.NODE_ENV !== 'production';

    if (authToken && signature) {
      if (!verifyTwilioSignature(callbackUrl, form, signature, authToken)) {
        incrementMetric('glamconnect_webhook_rejected_total');
        return reply.status(403).send({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid Twilio signature' } });
      }
    } else if (!isDev) {
      incrementMetric('glamconnect_webhook_rejected_total');
      return reply.status(403).send({ error: { code: 'INVALID_SIGNATURE', message: 'Missing Twilio signature or credentials' } });
    }

    const body = String(form.Body ?? '').trim();
    const from = stripWhatsAppPrefix(String(form.From ?? ''));
    if (body && isOptOutMessage(body) && from) {
      await recordOptOut({
        phone: from,
        channel: req.url?.includes('whatsapp') ? 'WHATSAPP' : 'SMS',
        provider: 'twilio',
        reason: body,
      });
      incrementMetric('glamconnect_webhook_opt_out_total');
      return reply.status(204).send();
    }

    const event = twilioStatusToEvent(form.MessageStatus ?? form.SmsStatus);
    if (event && form.MessageSid) {
      await applyDeliveryEvent({
        provider: 'twilio',
        messageId: form.MessageSid,
        eventType: event,
        providerStatus: String(form.MessageStatus ?? form.SmsStatus ?? ''),
        payload: { to: form.To, from: form.From },
      });
      incrementMetric('glamconnect_webhook_delivery_total');
    }
    return reply.status(204).send();
  };

  app.post('/webhooks/twilio/status', twilioHandler);
  app.post('/webhooks/twilio/inbound', twilioHandler);
  app.post('/api/v1/webhooks/twilio/status', twilioHandler);
  app.post('/api/v1/webhooks/twilio/inbound', twilioHandler);

  // ---------- Meta WhatsApp Cloud verification + callbacks ----------
  const whatsappGetHandler = async (req: any, reply: any) => {
    const q = req.query as Record<string, string>;
    if (!env.WHATSAPP_VERIFY_TOKEN || q['hub.verify_token'] !== env.WHATSAPP_VERIFY_TOKEN) {
      return reply.status(403).send({ error: { code: 'INVALID_VERIFY_TOKEN', message: 'Verification failed' } });
    }
    return reply.type('text/plain').send(q['hub.challenge'] ?? '');
  };

  const whatsappPostHandler = async (req: any, reply: any) => {
    const raw = String(req.rawBody ?? '');
    const signature = req.headers['x-hub-signature-256'];
    if (
      env.WHATSAPP_APP_SECRET &&
      !verifyHmacSha256(raw, env.WHATSAPP_APP_SECRET, typeof signature === 'string' ? signature : undefined)
    ) {
      incrementMetric('glamconnect_webhook_rejected_total');
      return reply.status(403).send({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid Meta signature' } });
    }

    const payload = (req.body ?? {}) as any;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};

        for (const status of value.statuses ?? []) {
          const event = metaStatusToEvent(status.status);
          if (event && status.id) {
            await applyDeliveryEvent({
              provider: 'whatsapp_cloud',
              messageId: String(status.id),
              eventType: event,
              providerStatus: String(status.status),
              payload: { recipient: status.recipient_id, conversation: status.conversation },
            });
            incrementMetric('glamconnect_webhook_delivery_total');
          }
        }

        for (const message of value.messages ?? []) {
          const from = message.from ? `+${String(message.from).replace(/^\+/, '')}` : '';
          const text =
            message.text?.body ??
            message.button?.text ??
            message.interactive?.button_reply?.title ??
            '';
          if (from && isOptOutMessage(text)) {
            await recordOptOut({
              phone: from,
              channel: 'WHATSAPP',
              provider: 'whatsapp_cloud',
              reason: text,
            });
            incrementMetric('glamconnect_webhook_opt_out_total');
          }
        }
      }
    }
    return reply.status(200).send({ received: true });
  };

  app.get('/webhooks/whatsapp', whatsappGetHandler);
  app.get('/api/v1/webhooks/whatsapp', whatsappGetHandler);
  app.post('/webhooks/whatsapp', whatsappPostHandler);
  app.post('/api/v1/webhooks/whatsapp', whatsappPostHandler);

  // ---------- Razorpay payment webhook ----------
  app.post('/webhooks/razorpay', async (req: any, reply) => {
    const raw = String(req.rawBody ?? '');
    const signature = req.headers['x-razorpay-signature'];
    try {
      const result = await applyRazorpayWebhook(raw, typeof signature === 'string' ? signature : undefined);
      incrementMetric('glamconnect_webhook_payment_total');
      return reply.status(200).send({ received: true, ...result });
    } catch (err) {
      req.log.warn({ err }, 'razorpay webhook rejected');
      return reply.status(403).send({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid Razorpay signature' } });
    }
  });

  // ---------- Generic delivery callback (internal notify service) ----------
  app.post('/webhooks/notifications', async (req: any, reply) => {
    const raw = String(req.rawBody ?? '');
    const signature = req.headers['x-notify-signature'];
    if (
      !env.DELIVERY_WEBHOOK_SECRET ||
      !verifyHmacSha256(raw, env.DELIVERY_WEBHOOK_SECRET, typeof signature === 'string' ? signature : undefined)
    ) {
      incrementMetric('glamconnect_webhook_rejected_total');
      return reply.status(403).send({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid callback signature' } });
    }
    const body = (req.body ?? {}) as {
      provider?: string;
      message_id?: string;
      event?: string;
      status?: string;
      [key: string]: unknown;
    };
    if (!body.message_id || !body.event) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'message_id and event are required' } });
    }
    await applyDeliveryEvent({
      provider: body.provider ?? 'webhook',
      messageId: String(body.message_id),
      eventType: String(body.event),
      providerStatus: body.status,
      payload: body,
    });
    return reply.status(204).send();
  });
};
