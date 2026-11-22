'use client';

import { useState } from 'react';
import {
  useCreateInvoice,
  usePartnerBookings,
  useUpdateBookingStatus,
  rupees,
  PartnerBooking,
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

  // Split payment modal state
  const [splitTarget, setSplitTarget] = useState<PartnerBooking | null>(null);
  const [part1Method, setPart1Method] = useState<'CASH' | 'UPI_QR' | 'CARD'>('CASH');
  const [part1AmountRupees, setPart1AmountRupees] = useState<string>('');
  const [part2Method, setPart2Method] = useState<'CASH' | 'UPI_QR' | 'CARD'>('UPI_QR');

  const openSplitModal = (b: PartnerBooking) => {
    setSplitTarget(b);
    const totalRupees = Math.round(b.total_payable_paise / 100);
    const half = Math.floor(totalRupees / 2);
    setPart1AmountRupees(String(half));
    setPart1Method('CASH');
    setPart2Method('UPI_QR');
  };

  const closeSplitModal = () => {
    setSplitTarget(null);
  };

  const submitSplitPayment = async () => {
    if (!splitTarget) return;
    setProblem(null);
    const totalPaise = splitTarget.total_payable_paise;
    const p1Paise = Math.round(Number(part1AmountRupees) * 100);
    const p2Paise = totalPaise - p1Paise;

    if (isNaN(p1Paise) || p1Paise <= 0 || p2Paise <= 0) {
      setProblem('Both split payment amounts must be greater than ₹0');
      return;
    }

    try {
      const res = await invoice.mutateAsync({
        bookingId: splitTarget.id,
        method: 'SPLIT',
        split_payments: [
          { method: part1Method, amount_paise: p1Paise },
          { method: part2Method, amount_paise: p2Paise },
        ],
      });
      setNotice(
        `${res.invoice_number} · collected ${rupees(res.net_collected_paise)} via Split (${part1Method} + ${part2Method})`,
      );
      setSplitTarget(null);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

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

      {notice && (
        <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">
          {notice}
        </div>
      )}
      {problem && (
        <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">
          {problem}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">
          {(error as Error).message}
        </div>
      )}
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
                <td>
                  <div className="space-y-1">
                    <p className="font-medium">{rupees(b.total_payable_paise)}</p>
                    {b.is_prepaid && (
                      <span className="inline-block text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                        ✓ Paid Online
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <span className="chip !py-0.5 !px-2">{b.status}</span>
                </td>
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
                        {b.is_prepaid ? (
                          <button
                            onClick={() => bill(b.id, 'ONLINE_UPI')}
                            disabled={invoice.isPending}
                            className="text-xs bg-emerald-600 text-white font-medium rounded-full px-2.5 py-1 hover:bg-emerald-700 shadow-sm transition-colors"
                            title="Invoice pre-paid appointment without double collection"
                          >
                            Generate Invoice (Pre-paid)
                          </button>
                        ) : (
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
                            <button
                              onClick={() => openSplitModal(b)}
                              disabled={invoice.isPending}
                              className="text-xs border border-accent/70 text-accent rounded-full px-2 py-1 hover:bg-accent/10"
                            >
                              Split
                            </button>
                          </>
                        )}
                      </>
                    )}
                    {b.status === 'COMPLETED' && <span className="text-[11px] opacity-50">Settled</span>}
                  </div>
                </td>
              </tr>
            ))}
            {!isLoading && !data?.bookings.length && (
              <tr>
                <td colSpan={7} className="p-6 text-center opacity-60">
                  No bookings on this date.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Split Payment Modal */}
      {splitTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="bg-[#1C161D] border border-line rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-display text-xl">Split Payment Collection</h3>
                <p className="text-xs opacity-60 mt-0.5">
                  Booking #{splitTarget.booking_code} · {splitTarget.customer_name}
                </p>
              </div>
              <button
                onClick={closeSplitModal}
                className="text-sm opacity-50 hover:opacity-100 p-1"
              >
                ✕
              </button>
            </div>

            <div className="rounded-xl bg-accent/10 border border-accent/20 p-3 flex justify-between items-center">
              <span className="text-sm opacity-80">Total Payable:</span>
              <span className="font-semibold text-lg text-accent">
                {rupees(splitTarget.total_payable_paise)}
              </span>
            </div>

            {/* Component 1 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium opacity-80">Payment Method 1</label>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={part1Method}
                  onChange={(e) => setPart1Method(e.target.value as any)}
                  className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
                >
                  <option value="CASH" className="bg-[#1C161D]">Cash</option>
                  <option value="UPI_QR" className="bg-[#1C161D]">UPI QR</option>
                  <option value="CARD" className="bg-[#1C161D]">Card POS</option>
                </select>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-sm opacity-60">₹</span>
                  <input
                    type="number"
                    min="1"
                    max={Math.floor(splitTarget.total_payable_paise / 100) - 1}
                    value={part1AmountRupees}
                    onChange={(e) => setPart1AmountRupees(e.target.value)}
                    className="w-full border border-line rounded-xl pl-7 pr-3 py-2 bg-transparent text-sm"
                    placeholder="Amount"
                  />
                </div>
              </div>
            </div>

            {/* Component 2 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium opacity-80">Payment Method 2 (Remaining)</label>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={part2Method}
                  onChange={(e) => setPart2Method(e.target.value as any)}
                  className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
                >
                  <option value="UPI_QR" className="bg-[#1C161D]">UPI QR</option>
                  <option value="CASH" className="bg-[#1C161D]">Cash</option>
                  <option value="CARD" className="bg-[#1C161D]">Card POS</option>
                </select>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-sm opacity-60">₹</span>
                  <input
                    type="number"
                    disabled
                    value={Math.max(
                      0,
                      Math.round(splitTarget.total_payable_paise / 100) - Number(part1AmountRupees || 0),
                    )}
                    className="w-full border border-line rounded-xl pl-7 pr-3 py-2 bg-white/5 opacity-80 text-sm cursor-not-allowed"
                  />
                </div>
              </div>
            </div>

            <div className="text-xs opacity-50 text-right">
              Sum = ₹
              {Number(part1AmountRupees || 0) +
                Math.max(0, Math.round(splitTarget.total_payable_paise / 100) - Number(part1AmountRupees || 0))}{' '}
              / ₹{Math.round(splitTarget.total_payable_paise / 100)}
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={closeSplitModal}
                className="flex-1 border border-line rounded-xl py-2 text-sm opacity-70 hover:opacity-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitSplitPayment}
                disabled={invoice.isPending}
                className="flex-1 bg-accent text-[#2D1B2E] font-medium rounded-xl py-2 text-sm hover:opacity-90 disabled:opacity-50"
              >
                {invoice.isPending ? 'Collecting…' : 'Collect & Settle'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
