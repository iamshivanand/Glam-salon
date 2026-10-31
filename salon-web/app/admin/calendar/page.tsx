'use client';

import { useState } from 'react';
import { usePartnerBookings } from '@/lib/api';
import { useAuth } from '@/lib/store';

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function bucket(iso: string) {
  const hour = Number(
    new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }),
  );
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

export default function AdminCalendar() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayIST());
  const { data } = usePartnerBookings(date, !!user);
  const bookings = data?.bookings ?? [];
  const buckets: Record<string, typeof bookings> = { Morning: [], Afternoon: [], Evening: [] };
  for (const b of bookings) buckets[bucket(b.scheduled_start_at)].push(b);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl">Booking calendar</h1>
          <p className="text-sm opacity-60 mt-1">Day view in Asia/Kolkata.</p>
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
        />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {Object.entries(buckets).map(([name, items]) => (
          <div key={name} className="card p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{name}</h2>
              <span className="text-xs opacity-60">{items.length}</span>
            </div>
            <div className="mt-3 space-y-2">
              {items.map((b) => (
                <div key={b.id} className="rounded-xl border border-line p-3 text-sm">
                  <p className="font-medium">
                    {new Date(b.scheduled_start_at).toLocaleTimeString('en-IN', {
                      timeZone: 'Asia/Kolkata',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' · '}
                    {b.customer_name}
                  </p>
                  <p className="text-xs opacity-60">{b.items.map((i) => i.service_name).join(', ')}</p>
                  <p className="text-[11px] opacity-50 mt-1">
                    {Array.from(new Set(b.items.map((i) => i.staff_name).filter(Boolean))).join(', ')}
                  </p>
                </div>
              ))}
              {!items.length && <p className="text-xs opacity-50">Nothing booked.</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
