'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth, useAuthModal } from '@/lib/store';
import {
  rupees,
  useStaffBookings,
  useStaffMe,
  useUpdateStaffBookingStatus,
  type StaffBooking,
} from '@/lib/api';

const NEXT_ACTION: Record<string, { label: string; status: string; primary?: boolean }[]> = {
  REQUESTED: [
    { label: 'Confirm', status: 'CONFIRMED', primary: true },
    { label: 'Decline', status: 'DECLINED' },
  ],
  CONFIRMED: [
    { label: 'Check in', status: 'ARRIVED', primary: true },
    { label: 'No show', status: 'NO_SHOW' },
  ],
  ARRIVED: [{ label: 'Start service', status: 'IN_SERVICE', primary: true }],
  IN_SERVICE: [{ label: 'Complete', status: 'COMPLETED', primary: true }],
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function shiftForDate(
  schedule: {
    day_of_week: number;
    override_date: string | null;
    shift_start: string;
    shift_end: string;
    breaks_json: { start: string; end: string }[];
    is_working_day: boolean;
  }[],
  date: string,
) {
  const dow = new Date(`${date}T12:00:00+05:30`).getDay();
  return (
    schedule.find((row) => row.override_date === date) ??
    schedule.find((row) => !row.override_date && row.day_of_week === dow) ??
    null
  );
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function BookingCard({
  booking,
  onMove,
  busy,
}: {
  booking: StaffBooking;
  onMove: (id: string, status: string) => void;
  busy: boolean;
}) {
  const actions = NEXT_ACTION[booking.status] ?? [];
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            {time(booking.scheduled_start_at)}–{time(booking.scheduled_end_at)} · {booking.customer_name}
          </p>
          <p className="text-xs opacity-60 mt-0.5">
            {booking.booking_code} · {booking.items.map((i) => i.service_name).join(', ')}
          </p>
        </div>
        <div className="text-right">
          <span className="chip !py-0.5 !px-2">{booking.status.replaceAll('_', ' ')}</span>
          <p className="text-xs opacity-60 mt-1">{rupees(booking.total_payable_paise)}</p>
        </div>
      </div>
      {booking.customer_notes && <p className="text-xs opacity-70 mt-2">Note: {booking.customer_notes}</p>}
      {actions.length > 0 && (
        <div className="flex gap-2 mt-3">
          {actions.map((a) => (
            <button
              key={a.status}
              disabled={busy}
              onClick={() => onMove(booking.id, a.status)}
              className={a.primary ? 'btn-primary !py-1.5 !px-3 text-sm' : 'chip !py-1.5 !px-3'}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StaffDashboard() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayIST());
  const [problem, setProblem] = useState<string | null>(null);

  const me = useStaffMe(true);
  const bookings = useStaffBookings(date, !!me.data);
  const move = useUpdateStaffBookingStatus();

  const schedule = me.data?.schedule ?? [];
  const shift = shiftForDate(schedule, date);
  const rows = bookings.data?.bookings ?? [];

  const onMove = (id: string, status: string) => {
    setProblem(null);
    move.mutate(
      { id, status },
      { onError: (err) => setProblem(err instanceof Error ? err.message : 'Could not update the booking') },
    );
  };

  if (me.isLoading) {
    return <div className="card p-8 mt-8">Loading your schedule…</div>;
  }

  if (me.error) {
    return (
      <div className="card p-8 mt-8">
        <h1 className="font-display text-2xl">No staff record linked</h1>
        <p className="opacity-70 mt-2 text-sm">
          This account is not linked to an active staff member yet. Ask the salon owner to link your phone number
          from the Staff page.
        </p>
        <p className="text-xs opacity-50 mt-2">{me.error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl">My day</h1>
          <p className="text-sm opacity-60 mt-1">
            {me.data?.salon.name} · {me.data?.staff.display_name}
            {me.data?.staff.specialization ? ` · ${me.data.staff.specialization}` : ''}
          </p>
        </div>
        <label className="text-sm">
          <span className="text-xs opacity-60 mr-2">Date</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value || todayIST())}
            className="border border-line rounded-xl px-3 py-2 bg-transparent"
          />
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="card p-5">
          <p className="text-xs opacity-60">Shift</p>
          {shift?.is_working_day ? (
            <>
              <p className="font-display text-3xl mt-1">
                {shift.shift_start.slice(0, 5)}–{shift.shift_end.slice(0, 5)}
              </p>
              <p className="text-xs opacity-60 mt-1">
                {shift.breaks_json?.length
                  ? `Break ${shift.breaks_json.map((b) => `${b.start}–${b.end}`).join(', ')}`
                  : 'No break scheduled'}
              </p>
            </>
          ) : (
            <p className="font-display text-3xl mt-1 opacity-60">Day off</p>
          )}
        </div>
        <div className="card p-5">
          <p className="text-xs opacity-60">Assigned bookings</p>
          <p className="font-display text-3xl mt-1">{rows.length}</p>
          <p className="text-xs opacity-60 mt-1">
            {rows.filter((b) => b.status === 'CONFIRMED').length} to check in ·{' '}
            {rows.filter((b) => b.status === 'IN_SERVICE').length} in service
          </p>
        </div>
      </div>

      <div className="card p-5">
        <p className="font-semibold mb-2">My bookings</p>
        {problem && <p className="text-sm text-red-600 mb-2">{problem}</p>}
        {bookings.isLoading && <p className="text-sm opacity-60">Loading…</p>}
        {!bookings.isLoading && rows.length === 0 && (
          <p className="text-sm opacity-60">Nothing assigned to you on this date.</p>
        )}
        <div className="space-y-3">
          {rows.map((booking) => (
            <BookingCard key={booking.id} booking={booking} onMove={onMove} busy={move.isPending} />
          ))}
        </div>
      </div>

      <div className="card p-5">
        <p className="font-semibold mb-3">Weekly schedule</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
          {DAYS.map((label, dow) => {
            const row = schedule.find((s) => !s.override_date && s.day_of_week === dow);
            return (
              <div key={label} className="border border-line rounded-xl px-3 py-2">
                <p className="text-xs opacity-60">{label}</p>
                <p className="font-medium mt-0.5">
                  {row?.is_working_day ? `${row.shift_start.slice(0, 5)}–${row.shift_end.slice(0, 5)}` : 'Off'}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs opacity-50">
        Signed in as {user?.full_name}. Staff accounts only see their own shift and assigned bookings.
      </p>
    </div>
  );
}

export default function StaffPage() {
  const { user, hydrated, logout } = useAuth();
  const { openModal } = useAuthModal();

  if (!hydrated) {
    return <div className="card p-8 mt-8">Checking your session…</div>;
  }

  if (!user) {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <p className="text-xs uppercase tracking-widest text-accent">Staff console</p>
        <h1 className="font-display text-3xl mt-2">Your schedule, in one place</h1>
        <p className="opacity-70 mt-2">Sign in with the phone number your salon linked to your staff record.</p>
        <button
          onClick={() => openModal('Sign in with the phone number linked to your staff record.')}
          className="btn-primary mt-5"
        >
          Sign in
        </button>
      </div>
    );
  }

  if (user.role !== 'STAFF') {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <h1 className="font-display text-3xl">Staff accounts only</h1>
        <p className="opacity-70 mt-2">
          You are signed in as {user.full_name}. Use the salon dashboard for management tools.
        </p>
        <div className="flex gap-2 justify-center mt-5">
          <Link href="/admin" className="btn-primary inline-block">
            Salon console
          </Link>
          <button
            onClick={() => {
              void logout();
            }}
            className="chip !py-3"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return <StaffDashboard />;
}
