'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  useCancelBooking,
  useCreatePaymentIntent,
  useMe,
  useMyBookings,
  usePayments,
  useSubmitReview,
  useVerifyPayment,
  rupees,
} from '@/lib/api';
import { useAuth, useAuthModal } from '@/lib/store';
import { clearPaymentKey, openRazorpayCheckout, paymentKey } from '@/lib/razorpay';

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Awaiting salon approval',
  CONFIRMED: 'Confirmed',
  ARRIVED: 'Checked in',
  IN_SERVICE: 'In service',
  COMPLETED: 'Completed',
  CANCELLED_BY_CUSTOMER: 'Cancelled',
  CANCELLED_BY_SALON: 'Cancelled by salon',
  DECLINED: 'Declined',
  NO_SHOW: 'No show',
  EXPIRED: 'Expired',
};

function ReviewForm({ bookingId }: { bookingId: string }) {
  const [open, setOpen] = useState(false);
  const [overall, setOverall] = useState(5);
  const [hygiene, setHygiene] = useState(5);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = useSubmitReview();

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-primary !py-2 !px-4 text-sm">
        Leave a review
      </button>
    );
  }

  return (
    <div className="w-full border-t border-line pt-3 mt-1 space-y-2">
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          Visit
          <select value={overall} onChange={(e) => setOverall(Number(e.target.value))} className="border border-line rounded-lg px-2 py-1 bg-transparent">
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} ★</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Hygiene
          <select value={hygiene} onChange={(e) => setHygiene(Number(e.target.value))} className="border border-line rounded-lg px-2 py-1 bg-transparent">
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} ★</option>)}
          </select>
        </label>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="What went well? What could be better?"
        className="w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
      />
      {problem && <p className="text-xs text-red-600">{problem}</p>}
      <div className="flex gap-2">
        <button
          onClick={async () => {
            setProblem(null);
            try {
              await submit.mutateAsync({
                bookingId,
                overall_rating: overall,
                hygiene_rating: hygiene,
                review_text: text.trim() || undefined,
              });
            } catch (err: any) {
              setProblem(err.message);
            }
          }}
          disabled={submit.isPending}
          className="btn-primary !py-2 !px-4 text-sm"
        >
          {submit.isPending ? 'Submitting…' : 'Submit review'}
        </button>
        <button onClick={() => setOpen(false)} className="text-xs underline opacity-60">Cancel</button>
      </div>
    </div>
  );
}

function CompletePayment({ bookingId, bookingCode }: { bookingId: string; bookingCode: string }) {
  const { user } = useAuth();
  const me = useMe(!!user);
  const createIntent = useCreatePaymentIntent();
  const verifyPayment = useVerifyPayment();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pay = async () => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const intent = await createIntent.mutateAsync({
        booking_id: bookingId,
        idempotency_key: paymentKey(bookingId),
      });
      if (!intent.checkout) {
        setProblem(intent.instructions ?? 'Online payment is not available for this booking.');
        return;
      }
      const contact = user?.phone?.replace(/^\+?91/, '');
      await openRazorpayCheckout({
        checkout: intent.checkout,
        description: bookingCode,
        prefill: {
          ...(user?.full_name ? { name: user.full_name } : {}),
          ...(contact ? { contact } : {}),
          ...(me.data?.email ? { email: me.data.email } : {}),
        },
        onSuccess: async (response) => {
          try {
            await verifyPayment.mutateAsync({ paymentId: intent.payment_id, ...response });
            clearPaymentKey(bookingId);
            setNotice('Payment captured. A receipt has been queued.');
          } catch (err: any) {
            setProblem(err.message);
          }
        },
      });
    } catch (err: any) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={pay} disabled={busy} className="btn-accent !py-2 !px-4 text-sm">
        {busy ? 'Opening checkout…' : 'Complete payment'}
      </button>
      {notice && <span className="text-xs opacity-70">{notice}</span>}
      {problem && <span className="text-xs text-red-600">{problem}</span>}
    </div>
  );
}

export default function AppointmentsPage() {
  const { user, hydrated } = useAuth();
  const { openModal } = useAuthModal();
  const { data, isLoading } = useMyBookings(!!user);
  const payments = usePayments(!!user);
  const cancel = useCancelBooking();
  const bookings = data?.bookings ?? [];

  // Latest payment order per booking decides whether an online payment is
  // still outstanding (an abandoned checkout leaves a CREATED order).
  const latestPayment = new Map<string, { status: string }>();
  for (const payment of payments.data?.payments ?? []) {
    if (payment.booking_id && !latestPayment.has(payment.booking_id)) {
      latestPayment.set(payment.booking_id, payment);
    }
  }
  const paymentPending = (bookingId: string) =>
    ['CREATED', 'PENDING', 'AUTHORIZED', 'FAILED'].includes(latestPayment.get(bookingId)?.status ?? '');

  if (hydrated && !user) {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <h1 className="font-display text-3xl">My visits</h1>
        <p className="opacity-70 mt-2">Sign in with your phone number to see bookings, check-in PINs and receipts.</p>
        <button onClick={() => openModal()} className="btn-primary mt-5">Sign in</button>
      </div>
    );
  }

  return (
    <div className="pt-8 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl">My visits</h1>
        <Link href="/book" className="btn-accent !py-2 text-sm">Book again</Link>
      </div>
      {isLoading && <p>Loading visits…</p>}
      {!isLoading && !bookings.length && (
        <div className="card p-8 text-center">
          <p className="opacity-70">No visits yet.</p>
          <Link href="/book" className="btn-primary inline-block mt-4">Find a salon</Link>
        </div>
      )}
      {bookings.map((b) => {
        const upcoming = ['REQUESTED', 'CONFIRMED'].includes(b.status);
        return (
          <div key={b.id} className="card p-5">
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex-1">
                <p className="font-semibold">{b.salon_name}</p>
                <p className="text-sm opacity-60">
                  {new Date(b.scheduled_start_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · {b.locality}
                </p>
                <p className="text-xs mt-1 opacity-50">Booking {b.booking_code}</p>
              </div>
              <span className="chip !py-1 !px-3">{STATUS_LABEL[b.status] ?? b.status}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 mt-4 border-t border-line pt-3">
              <span className="font-display text-xl">{rupees(b.total_payable_paise)}</span>
              {upcoming && paymentPending(b.id) && (
                <CompletePayment bookingId={b.id} bookingCode={b.booking_code} />
              )}
              {upcoming && (
                <button
                  onClick={() => cancel.mutate({ id: b.id, reason: 'Changed plans' })}
                  disabled={cancel.isPending}
                  className="text-xs underline opacity-60 hover:opacity-100"
                >
                  Cancel booking
                </button>
              )}
              {b.status === 'COMPLETED' &&
                (b.review_id ? (
                  <span className="text-xs opacity-60">★ Review submitted</span>
                ) : (
                  <ReviewForm bookingId={b.id} />
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
