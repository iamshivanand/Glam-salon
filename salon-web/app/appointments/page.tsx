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
  type MyBooking,
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
      <div className="flex items-center gap-3">
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

function CancelModal({
  booking,
  onClose,
}: {
  booking: MyBooking;
  onClose: () => void;
}) {
  const cancel = useCancelBooking();
  const [reason, setReason] = useState('Change of schedule');
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const activeItems = (booking.items ?? []).filter((i) => i.status !== 'CANCELLED_BY_CUSTOMER' && i.status !== 'CANCELLED_BY_SALON');
  const hasMultipleItems = activeItems.length > 1;

  const now = Date.now();
  const scheduledStart = new Date(booking.scheduled_start_at).getTime();
  const hoursUntil = (scheduledStart - now) / (3600 * 1000);
  const isLate = hoursUntil < 2;

  const handleToggleItem = (id: string) => {
    setSelectedItemIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleConfirmCancel = async () => {
    setError(null);
    try {
      const isPartial = hasMultipleItems && selectedItemIds.length > 0 && selectedItemIds.length < activeItems.length;
      await cancel.mutateAsync({
        id: booking.id,
        reason,
        cancel_item_ids: isPartial ? selectedItemIds : undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to cancel appointment');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface border border-line rounded-3xl p-6 sm:p-7 max-w-md w-full shadow-2xl relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-xl opacity-60 hover:opacity-100 transition">
          &times;
        </button>

        <h3 className="font-display text-2xl font-bold">Cancel Appointment</h3>
        <p className="text-xs opacity-70 mt-1">Booking {booking.booking_code} · {booking.salon_name}</p>

        {/* Cancellation policy banner */}
        <div className={`mt-4 p-3.5 rounded-2xl text-xs border ${
          isLate ? 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300' : 'bg-accent/10 border-accent/30 text-foreground'
        }`}>
          <p className="font-semibold">{isLate ? 'Late cancellation (within 2 hours)' : 'Standard cancellation (> 2 hours)'}</p>
          <p className="mt-0.5 opacity-90">
            {isLate
              ? 'Appointments cancelled less than 2 hours in advance are subject to a 50% cancellation fee. Any remaining 50% is refunded.'
              : 'Free cancellation. 100% of applicable paid amounts are refunded immediately to your original payment method.'}
          </p>
        </div>

        {/* Partial cancellation item selector */}
        {hasMultipleItems && (
          <div className="mt-4">
            <label className="block text-xs font-medium opacity-70 mb-1.5">
              Select services to cancel (leave empty to cancel all):
            </label>
            <div className="space-y-1.5 border border-line rounded-2xl p-2.5 max-h-36 overflow-y-auto">
              {activeItems.map((item) => {
                const checked = selectedItemIds.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleToggleItem(item.id)}
                    className={`w-full flex items-center justify-between p-2 rounded-xl text-left text-xs transition border ${
                      checked
                        ? 'bg-accent/15 border-accent text-foreground font-medium'
                        : 'border-transparent hover:bg-surface-raised opacity-80'
                    }`}
                  >
                    <span className="truncate pr-2">{item.service_name}</span>
                    <span className="whitespace-nowrap font-mono">{rupees(item.unit_price_paise)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-4">
          <label className="block text-xs font-medium opacity-70 mb-1">Reason for cancellation</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Schedule conflict"
            className="w-full border border-line rounded-xl px-3 py-2 bg-transparent text-xs"
          />
        </div>

        {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}

        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 rounded-full border border-line text-xs font-medium opacity-75 hover:opacity-100 transition"
          >
            Keep appointment
          </button>
          <button
            type="button"
            onClick={handleConfirmCancel}
            disabled={cancel.isPending}
            className="flex-1 py-2 rounded-full bg-red-600 hover:bg-red-700 text-white text-xs font-semibold disabled:opacity-50 transition"
          >
            {cancel.isPending ? 'Processing…' : hasMultipleItems && selectedItemIds.length > 0 && selectedItemIds.length < activeItems.length ? 'Cancel Selected' : 'Confirm Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AppointmentsPage() {
  const { user, hydrated } = useAuth();
  const { openModal } = useAuthModal();
  const { data, isLoading, error } = useMyBookings(!!user);
  const payments = usePayments(!!user);
  const cancel = useCancelBooking();
  const [showQrId, setShowQrId] = useState<string | null>(null);
  const [cancellingBooking, setCancellingBooking] = useState<MyBooking | null>(null);
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
      {isLoading && <p className="opacity-60 text-sm">Loading visits…</p>}
      {error && (
        <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/30 text-red-600 text-xs">
          Failed to load bookings: {(error as any)?.message ?? 'Server error'}
        </div>
      )}
      {!isLoading && !error && !bookings.length && (
        <div className="card p-8 text-center">
          <p className="opacity-70">No visits yet.</p>
          <Link href="/book" className="btn-primary inline-block mt-4">Find a salon</Link>
        </div>
      )}
      {bookings.map((b) => {
        const upcoming = ['REQUESTED', 'CONFIRMED'].includes(b.status);
        const qrOpen = showQrId === b.id;

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

            {/* Upcoming Booking: Check-in PIN and QR Card */}
            {upcoming && (
              <div className="mt-4 p-3.5 rounded-2xl bg-surface-raised border border-line flex items-center justify-between">
                <div>
                  <span className="text-[10px] uppercase font-bold tracking-wider text-accent">Arrival Check-in PIN</span>
                  <p className="font-mono text-xl font-bold tracking-widest mt-0.5">{b.checkin_pin ?? '—'}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowQrId(qrOpen ? null : b.id)}
                  className="px-3.5 py-1.5 rounded-full border border-line text-xs font-medium hover:border-accent hover:text-accent transition"
                >
                  {qrOpen ? 'Hide QR' : 'Show Check-in QR'}
                </button>
              </div>
            )}

            {/* Scannable QR Code display */}
            {upcoming && qrOpen && (
              <div className="mt-3 p-5 bg-white text-black rounded-2xl border border-line flex flex-col items-center justify-center text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(
                    JSON.stringify({ code: b.booking_code, pin: b.checkin_pin, id: b.id })
                  )}`}
                  alt={`Check-in QR for ${b.booking_code}`}
                  className="w-36 h-36 rounded-lg"
                />
                <p className="text-xs font-mono font-bold mt-2.5 tracking-widest">PIN: {b.checkin_pin}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Scan with partner scanner at reception for 1-tap arrival check-in</p>
              </div>
            )}

            {/* Services breakdown if present */}
            {b.items && b.items.length > 0 && (
              <div className="mt-3.5 pt-3 border-t border-line space-y-1">
                {b.items.map((item) => (
                  <div key={item.id} className="flex items-center justify-between text-xs opacity-75">
                    <span className={item.status === 'CANCELLED_BY_CUSTOMER' ? 'line-through opacity-50' : ''}>
                      {item.service_name} {item.status === 'CANCELLED_BY_CUSTOMER' && '(Cancelled)'}
                    </span>
                    <span className="font-mono">{rupees(item.unit_price_paise)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 mt-4 border-t border-line pt-3">
              <span className="font-display text-xl">{rupees(b.total_payable_paise)}</span>
              {upcoming && paymentPending(b.id) && (
                <CompletePayment bookingId={b.id} bookingCode={b.booking_code} />
              )}
              {upcoming && (
                <button
                  type="button"
                  onClick={() => setCancellingBooking(b)}
                  className="text-xs underline opacity-60 hover:opacity-100 hover:text-red-500 transition"
                >
                  Cancel booking / services
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

      {cancellingBooking && (
        <CancelModal booking={cancellingBooking} onClose={() => setCancellingBooking(null)} />
      )}
    </div>
  );
}
