import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../http.js';
import { parse } from '../http.js';
import { authenticate } from '../auth.js';
import {
  createPaymentIntent,
  listPaymentsForCustomer,
  paymentCapabilities,
  verifyPayment,
} from '../services/payments.js';

const IntentInput = z.object({
  booking_id: z.string().uuid().optional(),
  invoice_id: z.string().uuid().optional(),
  amount_paise: z.number().int().positive().optional(),
});

const VerifyInput = z.object({
  razorpay_order_id: z.string().min(4),
  razorpay_payment_id: z.string().min(4),
  razorpay_signature: z.string().min(8),
});

function idempotencyKey(req: any): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 64) {
    throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key header (8-64 chars)');
  }
  return key;
}

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/payments/capabilities', async () => paymentCapabilities());

  app.get('/payments', { preHandler: [authenticate] }, async (req) => {
    return { payments: await listPaymentsForCustomer(req.auth!.id) };
  });

  app.post('/payments/intents', { preHandler: [authenticate] }, async (req) => {
    const body = parse(IntentInput, req.body);
    if (!body.booking_id && !body.invoice_id) {
      throw badRequest('VALIDATION_ERROR', 'booking_id or invoice_id is required');
    }
    return createPaymentIntent({
      customerId: req.auth!.id,
      bookingId: body.booking_id,
      invoiceId: body.invoice_id,
      amountPaise: body.amount_paise,
      idempotencyKey: idempotencyKey(req),
    });
  });

  app.post('/payments/:id/verify', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(VerifyInput, req.body);
    return verifyPayment({
      paymentId: id,
      customerId: req.auth!.id,
      razorpayOrderId: body.razorpay_order_id,
      razorpayPaymentId: body.razorpay_payment_id,
      razorpaySignature: body.razorpay_signature,
    });
  });
};
