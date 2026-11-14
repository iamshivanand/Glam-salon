/**
 * Pure message rendering. No DB, Redis or provider imports, so these functions
 * can be unit tested and reused by both the reminder dispatcher and the
 * transactional notifier.
 */

export type TransactionalTemplate =
  | 'BOOKING_REQUESTED'
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_CANCELLED'
  | 'BOOKING_RESCHEDULED'
  | 'BOOKING_COMPLETED'
  | 'INVOICE_READY'
  | 'QUEUE_JOINED'
  | 'QUEUE_CALLED'
  | 'PAYMENT_RECEIPT'
  | 'PAYMENT_REFUNDED';

export interface TemplateContext {
  customerName: string;
  salonName: string;
  serviceName?: string;
  whenLocal?: string;
  bookingCode?: string;
  amountInr?: string;
  tokenNumber?: number | string;
  deepLink?: string;
  reason?: string;
}

function firstName(name: string): string {
  return name.split(' ')[0] || 'there';
}

/**
 * Message copy. WhatsApp template params are kept separate because approved
 * templates use positional placeholders, not the free-form body.
 */
export function renderTransactional(
  template: TransactionalTemplate,
  ctx: TemplateContext,
): { subject: string; text: string; params: string[] } {
  const name = firstName(ctx.customerName);
  const when = ctx.whenLocal ? ` on ${ctx.whenLocal}` : '';
  const service = ctx.serviceName ? ` for ${ctx.serviceName}` : '';
  const code = ctx.bookingCode ? ` (${ctx.bookingCode})` : '';

  switch (template) {
    case 'BOOKING_REQUESTED':
      return {
        subject: `Booking request received — ${ctx.salonName}`,
        text: `Hi ${name}, we received your booking request${service} at ${ctx.salonName}${when}${code}. The salon will confirm shortly.`,
        params: [name, ctx.salonName, ctx.serviceName ?? 'your service', ctx.whenLocal ?? '', ctx.bookingCode ?? ''],
      };
    case 'BOOKING_CONFIRMED':
      return {
        subject: `Booking confirmed — ${ctx.salonName}`,
        text: `Hi ${name}, your booking${service} at ${ctx.salonName}${when} is confirmed${code}. See you soon!`,
        params: [name, ctx.salonName, ctx.serviceName ?? 'your service', ctx.whenLocal ?? '', ctx.bookingCode ?? ''],
      };
    case 'BOOKING_CANCELLED':
      return {
        subject: `Booking cancelled — ${ctx.salonName}`,
        text: `Hi ${name}, your booking${service} at ${ctx.salonName}${when}${code} has been cancelled.${ctx.reason ? ` Reason: ${ctx.reason}.` : ''}`,
        params: [name, ctx.salonName, ctx.whenLocal ?? '', ctx.bookingCode ?? ''],
      };
    case 'BOOKING_RESCHEDULED':
      return {
        subject: `Booking moved — ${ctx.salonName}`,
        text: `Hi ${name}, your booking${service} at ${ctx.salonName} has been moved${when}${code}.`,
        params: [name, ctx.salonName, ctx.serviceName ?? 'your service', ctx.whenLocal ?? ''],
      };
    case 'BOOKING_COMPLETED':
      return {
        subject: `Thanks for visiting ${ctx.salonName}`,
        text: `Hi ${name}, thanks for visiting ${ctx.salonName}${when}. We would love your feedback${ctx.deepLink ? `: ${ctx.deepLink}` : '.'}`,
        params: [name, ctx.salonName, ctx.deepLink ?? ''],
      };
    case 'INVOICE_READY':
      return {
        subject: `Your invoice from ${ctx.salonName}`,
        text: `Hi ${name}, your invoice${code} from ${ctx.salonName} is ready. Total: ₹${ctx.amountInr ?? '0'}.`,
        params: [name, ctx.salonName, ctx.amountInr ?? '0', ctx.bookingCode ?? ''],
      };
    case 'QUEUE_JOINED':
      return {
        subject: `You're in the queue at ${ctx.salonName}`,
        text: `Hi ${name}, you joined the walk-in queue at ${ctx.salonName}. Your token is #${ctx.tokenNumber ?? '—'}. We'll message you when it's your turn.`,
        params: [name, ctx.salonName, String(ctx.tokenNumber ?? '')],
      };
    case 'QUEUE_CALLED':
      return {
        subject: `It's your turn at ${ctx.salonName}`,
        text: `Hi ${name}, token #${ctx.tokenNumber ?? '—'} is being called at ${ctx.salonName}. Please head to the reception.`,
        params: [name, ctx.salonName, String(ctx.tokenNumber ?? '')],
      };
    case 'PAYMENT_RECEIPT':
      return {
        subject: `Payment received — ${ctx.salonName}`,
        text: `Hi ${name}, we received ₹${ctx.amountInr ?? '0'} for your visit to ${ctx.salonName}${code}. Thank you!`,
        params: [name, ctx.salonName, ctx.amountInr ?? '0', ctx.bookingCode ?? ''],
      };
    case 'PAYMENT_REFUNDED':
      return {
        subject: `Refund processed — ${ctx.salonName}`,
        text: `Hi ${name}, a refund of ₹${ctx.amountInr ?? '0'} for ${ctx.salonName}${code} has been processed. It may take 5–7 working days to appear.`,
        params: [name, ctx.salonName, ctx.amountInr ?? '0', ctx.bookingCode ?? ''],
      };
  }
}

export interface ReminderRenderInput {
  template_code: string;
  customer_name: string;
  salon_name: string;
  category_name: string;
  deep_link_token: string;
}

/** Render a retention reminder using the public click-tracking URL as the CTA. */
export function renderReminderMessage(
  row: ReminderRenderInput,
  apiBaseUrl: string,
): { subject: string; text: string } {
  const name = firstName(row.customer_name);
  const link = `${apiBaseUrl.replace(/\/$/, '')}/r/${row.deep_link_token}`;
  const service = row.category_name.toLowerCase();

  switch (row.template_code) {
    case 'DAY_20_GENTLE':
      return {
        subject: `${name}, your ${service} is coming up`,
        text: `Hi ${name}, it's almost time for your next ${service} at ${row.salon_name}. Pick a slot that suits you: ${link}`,
      };
    case 'DAY_25_INVITE':
      return {
        subject: `${name}, book your ${service} at ${row.salon_name}`,
        text: `Hi ${name}, your ${service} at ${row.salon_name} is due around now. Reserve your preferred time: ${link}`,
      };
    case 'DAY_35_REENGAGE':
      return {
        subject: `We miss you at ${row.salon_name}`,
        text: `Hi ${name}, it has been a while since your last ${service} at ${row.salon_name}. Treat yourself and book again: ${link}`,
      };
    default:
      return {
        subject: `A note from ${row.salon_name}`,
        text: `Hi ${name}, ${row.salon_name} would love to see you again. Book your next visit: ${link}`,
      };
  }
}
