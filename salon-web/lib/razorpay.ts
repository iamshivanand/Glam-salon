'use client';

export type RazorpayCheckoutConfig = {
  provider: string;
  key: string;
  order_id: string;
  amount: number;
  currency: string;
};

export type RazorpayResponse = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

export function loadRazorpay(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).Razorpay) return resolve();
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Could not load the payment checkout')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the payment checkout'));
    document.body.appendChild(script);
  });
}

/**
 * Stable idempotency key for one payment attempt in this browser session.
 * Repeated taps (and returns to the same booking) reuse the open Razorpay
 * order instead of creating duplicate orders; a successful payment clears it.
 */
export function paymentKey(bookingId: string): string {
  const scope = `gc_paykey:${bookingId}`;
  let key = window.sessionStorage.getItem(scope);
  if (!key) {
    key = crypto.randomUUID();
    window.sessionStorage.setItem(scope, key);
  }
  return key;
}

export function clearPaymentKey(bookingId: string): void {
  window.sessionStorage.removeItem(`gc_paykey:${bookingId}`);
}

export async function openRazorpayCheckout(opts: {
  checkout: RazorpayCheckoutConfig;
  description?: string;
  prefill?: { name?: string; contact?: string; email?: string };
  onSuccess: (response: RazorpayResponse) => Promise<void> | void;
}): Promise<void> {
  await loadRazorpay();
  const checkout = opts.checkout;
  const rzp = new (window as any).Razorpay({
    key: checkout.key,
    amount: checkout.amount,
    currency: checkout.currency,
    order_id: checkout.order_id,
    name: 'Glam Connect',
    description: opts.description,
    prefill: opts.prefill,
    handler: (response: RazorpayResponse) => {
      void opts.onSuccess(response);
    },
    theme: { color: '#7c3aed' },
  });
  rzp.open();
}
