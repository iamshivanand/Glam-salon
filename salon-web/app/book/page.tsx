'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  useAvailability,
  useCreateBooking,
  useCreatePaymentIntent,
  useHold,
  useMe,
  usePaymentCapabilities,
  useSalon,
  useSalonSearch,
  useVerifyPayment,
  rupees,
  type PaymentIntent,
  type Slot,
} from '@/lib/api';
import { useAuth, useAuthModal, useBooking } from '@/lib/store';
import { serviceImage, staffImage } from '@/lib/images';

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the payment checkout'));
    document.body.appendChild(script);
  });
}

export default function BookPage() {
  const [step, setStep] = useState(1);
  const [confirmation, setConfirmation] = useState<{
    booking_code: string;
    checkin_pin: string;
    scheduled_start_at: string;
    total_payable_paise: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeAfterSignIn, setResumeAfterSignIn] = useState(false);
  const [reminderToken, setReminderToken] = useState<string | undefined>();
  const [payMode, setPayMode] = useState<'PAY_AT_SALON' | 'PAY_ONLINE'>('PAY_AT_SALON');
  const [paymentIntent, setPaymentIntent] = useState<PaymentIntent | null>(null);
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);

  const { data: search } = useSalonSearch({ lat: 12.9719, lng: 77.6412, radius_km: 15 });
  const salons = search?.salons ?? [];
  const b = useBooking();
  const { user, hydrated } = useAuth();
  const { openModal } = useAuthModal();

  const activeSalonId = b.salonId ?? salons[0]?.id;
  const { data: profile, isLoading: loadingProfile } = useSalon(activeSalonId);
  const availability = useAvailability(activeSalonId, b.serviceIds, b.date, b.staffId);
  const hold = useHold();
  const create = useCreateBooking();
  const capabilities = usePaymentCapabilities();
  const me = useMe(!!user);
  const createIntent = useCreatePaymentIntent();
  const verifyPayment = useVerifyPayment();

  useEffect(() => {
    if (b.date < todayIST()) b.set({ date: todayIST() });
    // Reminder deep links carry ?salon=<id>&ref=<token>; keep the token so the
    // booking can be attributed back to the reminder that brought them here.
    const params = new URLSearchParams(window.location.search);
    const linkedSalon = params.get('salon');
    if (linkedSalon) useBooking.getState().setSalon(linkedSalon);
    const ref = params.get('ref');
    if (ref) setReminderToken(ref);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => (profile?.services ?? []).filter((s) => b.serviceIds.includes(s.id)),
    [profile, b.serviceIds],
  );
  const total = selected.reduce((sum, s) => sum + (s.discounted_price_paise ?? s.base_price_paise), 0);
  // With "Anyone" selected the API returns one slot per available artist, which
  // shows the same time twice. Collapse to unique start times; picking an artist
  // narrows the response to that artist anyway.
  const slots = useMemo(() => {
    const all = availability.data?.slots ?? [];
    if (b.staffId) return all;
    const seen = new Set<string>();
    return all.filter((s) => (seen.has(s.start) ? false : (seen.add(s.start), true)));
  }, [availability.data, b.staffId]);
  const slot: Slot | undefined = slots.find((s) => s.start === b.time);

  async function confirm() {
    if (!activeSalonId || !slot) return;
    if (!user) {
      setResumeAfterSignIn(true);
      openModal('Sign in to lock your slot and confirm the booking.');
      return;
    }
    setError(null);
    try {
      const held = await hold.mutateAsync({
        salon_id: activeSalonId,
        service_ids: b.serviceIds,
        staff_id: slot.staff_id,
        start_at: slot.start_at,
      });
      const booking = await create.mutateAsync({ hold_token: held.hold_token, reminder_token: reminderToken });
      setConfirmation(booking);
      if (payMode === 'PAY_ONLINE') {
        try {
          const intent = await createIntent.mutateAsync({ booking_id: booking.id });
          setPaymentIntent(intent);
          if (!intent.checkout) {
            setPaymentNotice(intent.instructions ?? 'Online payment is not configured; pay at the salon.');
          }
        } catch (err: any) {
          setPaymentNotice(`Booking saved. Online payment is unavailable: ${err.message}`);
        }
      }
      setStep(4);
      b.reset();
    } catch (err: any) {
      setError(err.message ?? 'Could not confirm this booking. Please pick another slot.');
    }
  }

  // Once the OTP modal signs the customer in, continue the booking they started.
  useEffect(() => {
    if (!resumeAfterSignIn || !user) return;
    setResumeAfterSignIn(false);
    void confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, resumeAfterSignIn]);

  const payNow = async () => {
    if (!paymentIntent?.checkout) return;
    setPaymentNotice(null);
    try {
      await loadScript('https://checkout.razorpay.com/v1/checkout.js');
      const checkout = paymentIntent.checkout;
      const contact = user?.phone?.replace(/^\+?91/, '');
      const rzp = new (window as any).Razorpay({
        key: checkout.key,
        amount: checkout.amount,
        currency: checkout.currency,
        order_id: checkout.order_id,
        name: 'Glam Connect',
        description: confirmation?.booking_code,
        prefill: {
          ...(user?.full_name ? { name: user.full_name } : {}),
          ...(contact ? { contact } : {}),
          ...(me.data?.email ? { email: me.data.email } : {}),
        },
        handler: async (response: any) => {
          try {
            await verifyPayment.mutateAsync({ paymentId: paymentIntent.payment_id, ...response });
            setPaymentNotice('Payment captured. A receipt has been queued.');
          } catch (err: any) {
            setPaymentNotice(err.message);
          }
        },
        theme: { color: '#7c3aed' },
      });
      rzp.open();
    } catch (err: any) {
      setPaymentNotice(err.message);
    }
  };

  if (confirmation) {
    return (
      <div className="card p-10 mt-8 text-center max-w-xl mx-auto">
        <p className="text-5xl">✨</p>
        <h2 className="font-display text-3xl mt-2">You&apos;re booked!</h2>
        <p className="opacity-70 mt-2">
          {new Date(confirmation.scheduled_start_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
        </p>
        <div className="mt-5 inline-flex flex-col gap-1 rounded-2xl border border-line px-6 py-4">
          <span className="text-xs uppercase tracking-widest opacity-50">Booking code</span>
          <span className="font-display text-2xl">{confirmation.booking_code}</span>
          <span className="text-xs opacity-60 mt-2">Check-in PIN</span>
          <span className="tracking-[0.4em] text-lg">{confirmation.checkin_pin}</span>
        </div>
        <p className="text-sm opacity-60 mt-4">Total {rupees(confirmation.total_payable_paise)} · {payMode === 'PAY_ONLINE' ? 'online payment' : 'pay at the salon'}</p>
        {paymentIntent?.checkout && !paymentNotice?.startsWith('Payment captured') && (
          <button onClick={payNow} className="btn-accent mt-3">Pay {rupees(paymentIntent.amount_paise)} now</button>
        )}
        {paymentNotice && <p className="text-sm mt-3 opacity-80">{paymentNotice}</p>}
        <div className="flex gap-2 justify-center mt-6">
          <Link href="/appointments" className="btn-primary">View my visits</Link>
          <button onClick={() => setConfirmation(null)} className="chip">Book another</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-8 max-w-3xl mx-auto">
      <h1 className="font-display text-4xl">Book your visit</h1>
      <p className="text-sm opacity-60 mt-1">Real-time availability across Glam Connect salons.</p>
      <div className="flex gap-2 mt-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className={`h-2 flex-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-line'}`} />
        ))}
      </div>

      {step === 1 && (
        <div className="card p-6 mt-6 space-y-4">
          <h2 className="font-semibold">1 · Salon & services</h2>
          <select
            value={activeSalonId ?? ''}
            onChange={(e) => b.setSalon(e.target.value)}
            className="w-full border border-line rounded-xl px-3 py-2.5 bg-transparent text-sm"
          >
            {salons.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.locality} · ★ {s.avg_rating.toFixed(1)}</option>
            ))}
          </select>

          {loadingProfile && <p className="text-sm opacity-60">Loading catalogue…</p>}

          <div className="space-y-2 max-h-[420px] overflow-auto pr-1">
            {(profile?.services ?? []).map((s) => {
              const price = s.discounted_price_paise ?? s.base_price_paise;
              return (
                <label key={s.id} className="flex items-center gap-3 border border-line rounded-2xl p-3 cursor-pointer">
                  <input type="checkbox" checked={b.serviceIds.includes(s.id)} onChange={() => b.toggleService(s.id)} />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={serviceImage(s.category_slug)} alt="" className="w-12 h-12 rounded-xl object-cover" />
                  <span className="flex-1">
                    <b>{s.custom_name}</b>
                    <span className="block text-xs opacity-60">{s.category_name} · {s.duration_mins} min</span>
                  </span>
                  <span className="text-sm">{rupees(price)}</span>
                </label>
              );
            })}
          </div>

          <button disabled={!b.serviceIds.length} onClick={() => setStep(2)} className="btn-primary w-full">
            Continue · {rupees(total)}
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="card p-6 mt-6 space-y-4">
          <h2 className="font-semibold">2 · Artist, date & time</h2>

          <div className="flex gap-2 flex-wrap">
            <button onClick={() => b.set({ staffId: undefined })} className={`chip ${!b.staffId ? 'chip-active' : ''}`}>
              Anyone
            </button>
            {(profile?.staff ?? []).map((p, i) => (
              <button
                key={p.id}
                onClick={() => b.set({ staffId: p.id })}
                className={`chip flex items-center gap-2 ${b.staffId === p.id ? 'chip-active' : ''}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={staffImage(i)} alt="" className="w-5 h-5 rounded-full object-cover" />
                {p.display_name.split(' ')[0]} ★{Number(p.avg_rating).toFixed(1)}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <input
              type="date"
              min={todayIST()}
              value={b.date}
              onChange={(e) => b.set({ date: e.target.value })}
              className="border border-line rounded-xl px-3 py-2 bg-transparent"
            />
            <span className="text-xs opacity-60">
              {availability.data ? `${availability.data.total_duration_mins} min total` : ''}
            </span>
          </div>

          {availability.isFetching && <p className="text-sm opacity-60">Finding open slots…</p>}
          {availability.error && <p className="text-sm text-red-600">{(availability.error as Error).message}</p>}

          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-64 overflow-auto">
            {slots.map((s) => (
              <button
                key={`${s.start_at}-${s.staff_id}`}
                onClick={() => b.set({ time: s.start })}
                className={`slot ${b.time === s.start ? 'slot-on' : 'border-line'}`}
                title={s.instant_confirm ? 'Instant confirmation' : 'Salon approval required'}
              >
                {s.start}
              </button>
            ))}
          </div>
          {availability.data && slots.length === 0 && (
            <p className="text-sm opacity-60">No open slots for this selection. Try another date or artist.</p>
          )}

          <div className="flex gap-2">
            <button onClick={() => setStep(1)} className="chip">Back</button>
            <button disabled={!b.time} onClick={() => setStep(3)} className="btn-primary flex-1">Continue</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card p-6 mt-6 space-y-4">
          <h2 className="font-semibold">3 · Confirm</h2>
          <div className="space-y-1 text-sm">
            {selected.map((s) => (
              <div key={s.id} className="flex justify-between">
                <span>{s.custom_name}</span>
                <span>{rupees(s.discounted_price_paise ?? s.base_price_paise)}</span>
              </div>
            ))}
            <div className="flex justify-between font-semibold border-t border-line pt-2 mt-2">
              <span>Total</span>
              <span>{rupees(total)}</span>
            </div>
          </div>
          <p className="text-sm opacity-70">
            {profile?.name} · {b.date} at {b.time} · {user ? user.full_name : 'Sign in to confirm'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setPayMode('PAY_AT_SALON')}
              className={`chip !py-2 ${payMode === 'PAY_AT_SALON' ? 'chip-active' : ''}`}
            >
              Pay at salon
            </button>
            <button
              onClick={() => setPayMode('PAY_ONLINE')}
              className={`chip !py-2 ${payMode === 'PAY_ONLINE' ? 'chip-active' : ''}`}
            >
              Pay online
            </button>
            {payMode === 'PAY_ONLINE' && capabilities.data && !capabilities.data.configured && (
              <span className="text-[11px] text-amber-700 self-center">
                Online payment is not configured on this server; the booking will still be saved.
              </span>
            )}
          </div>
          {!hydrated && <p className="text-xs opacity-60">Checking your session…</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button onClick={() => setStep(2)} className="chip">Back</button>
            <button
              onClick={confirm}
              disabled={hold.isPending || create.isPending || !slot}
              className="btn-accent flex-1"
            >
              {hold.isPending || create.isPending ? 'Locking your slot…' : user ? 'Confirm booking' : 'Sign in & confirm'}
            </button>
          </div>
          <p className="text-[11px] opacity-50">
            Your slot is held for 5 minutes while you confirm. Choose pay-at-salon, or pay online when the payment provider is configured.
          </p>
        </div>
      )}
    </div>
  );
}
