'use client';

import Link from 'next/link';
import { useCancelBooking, useMyBookings, rupees } from '@/lib/api';
import { useAuth, useAuthModal } from '@/lib/store';

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

export default function AppointmentsPage() {
  const { user, hydrated } = useAuth();
  const { openModal } = useAuthModal();
  const { data, isLoading } = useMyBookings(!!user);
  const cancel = useCancelBooking();
  const bookings = data?.bookings ?? [];

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
              {upcoming && (
                <button
                  onClick={() => cancel.mutate({ id: b.id, reason: 'Changed plans' })}
                  disabled={cancel.isPending}
                  className="text-xs underline opacity-60 hover:opacity-100"
                >
                  Cancel booking
                </button>
              )}
              {b.status === 'COMPLETED' && <span className="text-xs opacity-60">Visit verified · review from the app</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
