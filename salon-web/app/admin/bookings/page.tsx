'use client';

import { useState } from 'react';
import {
  useCreateInvoice,
  usePartnerBookings,
  useUpdateBookingStatus,
  rupees,
} from '@/lib/api';
import { useAuth } from '@/lib/store';

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

const NEXT_ACTION: Record<string, { label: string; status: string }[]> = {
  REQUESTED: [
    { label: 'Confirm', status: 'CONFIRMED' },
    { label: 'Decline', status: 'DECLINED' },
  ],
  CONFIRMED: [
    { label: 'Check in', status: 'ARRIVED' },
    { label: 'No show', status: 'NO_SHOW' },
  ],
  ARRIVED: [{ label: 'Start service', status: 'IN_SERVICE' }],
};

export default function AdminBookings() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayIST());
  const { data, isLoading, error } = usePartnerBookings(date, !!user);
  const update = useUpdateBookingStatus();
  const invoice = useCreateInvoice();
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const act = async (id: string, status: string) => {
    setProblem(null);
    try {
      await update.mutateAsync({ id, status });
      setNotice(`Booking moved to ${status.replaceAll('_', ' ').toLowerCase()}`);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const bill = async (id: string, method: string) => {
    setProblem(null);
    try {
      const res = await invoice.mutateAsync({ bookingId: id, method });
      setNotice(`${res.invoice_number} · collected ${rupees(res.net_collected_paise)}`);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl">Bookings</h1>
          <p className="text-sm opacity-60 mt-1">Day book, check-ins and POS collection.</p>
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
        />
      </div>

      {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">{notice}</div>}
      {problem && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{problem}</div>}
      {error && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{(error as Error).message}</div>}
      {isLoading && <p>Loading day book…</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Time</th>
              <th>Customer</th>
              <th>Services</th>
              <th>Artist</th>
              <th>Total</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.bookings ?? []).map((b) => (
              <tr key={b.id} className="border-t border-line align-top">
                <td className="p-3 whitespace-nowrap">
                  {new Date(b.scheduled_start_at).toLocaleTimeString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td>
                  <p className="font-medium">{b.customer_name}</p>
                  <p className="text-[11px] opacity-50">{b.booking_code}</p>
                </td>
                <td className="max-w-[220px]">{b.items.map((i) => i.service_name).join(', ')}</td>
                <td>{Array.from(new Set(b.items.map((i) => i.staff_name).filter(Boolean))).join(', ') || '—'}</td>
                <td>{rupees(b.total_payable_paise)}</td>
                <td><span className="chip !py-0.5 !px-2">{b.status}</span></td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {(NEXT_ACTION[b.status] ?? []).map((a) => (
                      <button
                        key={a.status}
                        onClick={() => act(b.id, a.status)}
                        disabled={update.isPending}
                        className="text-xs border border-line rounded-full px-2 py-1 hover:border-accent"
                      >
                        {a.label}
                      </button>
                    ))}
                    {['ARRIVED', 'IN_SERVICE'].includes(b.status) && (
                      <>
                        <button
                          onClick={() => bill(b.id, 'UPI_QR')}
                          disabled={invoice.isPending}
                          className="text-xs bg-accent text-[#2D1B2E] rounded-full px-2 py-1"
                        >
                          Bill · UPI
                        </button>
                        <button
                          onClick={() => bill(b.id, 'CASH')}
                          disabled={invoice.isPending}
                          className="text-xs border border-line rounded-full px-2 py-1"
                        >
                          Cash
                        </button>
                      </>
                    )}
                    {b.status === 'COMPLETED' && <span className="text-[11px] opacity-50">Settled</span>}
                  </div>
                </td>
              </tr>
            ))}
            {!isLoading && !data?.bookings.length && (
              <tr><td colSpan={7} className="p-6 text-center opacity-60">No bookings on this date.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
