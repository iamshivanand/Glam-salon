'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/store';
import {
  rupees,
  usePartnerPayments,
  usePartnerSettlements,
  usePaymentCapabilities,
  useRefundPayment,
} from '@/lib/api';

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export default function SettlementsPage() {
  const { user } = useAuth();
  const [from, setFrom] = useState(() => {
    const d = new Date(Date.now() + 5.5 * 3600_000);
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(todayIST());
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const settlements = usePartnerSettlements(from, to, !!user);
  const payments = usePartnerPayments(!!user);
  const capabilities = usePaymentCapabilities();
  const refund = useRefundPayment();

  const doRefund = async (id: string, amount: number) => {
    setNotice(null);
    setProblem(null);
    if (!window.confirm(`Refund ${rupees(amount)} for this payment?`)) return;
    try {
      const res: any = await refund.mutateAsync({ id, amount_paise: amount, reason: 'Partner-initiated refund' });
      setNotice(
        res?.simulated
          ? `Refund recorded locally (${rupees(res.refunded_paise)}). No gateway was called.`
          : `Refund submitted to the gateway (${rupees(res?.refunded_paise ?? amount)}).`,
      );
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-4xl">Settlements</h1>
        <p className="text-sm opacity-60 mt-1">
          Commission and partner payout computed from captured invoices (Asia/Kolkata days). Payout execution
          depends on the configured payment provider.
        </p>
      </div>

      <div className="card p-5 flex flex-wrap items-end gap-3">
        <label className="text-xs opacity-60">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="block mt-1 border border-line rounded-xl px-3 py-2 bg-transparent" />
        </label>
        <label className="text-xs opacity-60">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="block mt-1 border border-line rounded-xl px-3 py-2 bg-transparent" />
        </label>
        <div className="ml-auto text-xs opacity-60">
          Payment provider: <b>{capabilities.data?.provider ?? '…'}</b>
          {capabilities.data && !capabilities.data.configured && (
            <span className="text-amber-700"> · not configured</span>
          )}
        </div>
      </div>

      {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">{notice}</div>}
      {problem && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{problem}</div>}

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          ['Gross', rupees(settlements.data?.totals.gross_paise)],
          ['Commission', rupees(settlements.data?.totals.commission_paise)],
          ['Partner payout', rupees(settlements.data?.totals.partner_paise)],
          ['Invoices', settlements.data?.totals.invoices ?? 0],
        ].map(([label, value]) => (
          <div key={String(label)} className="card p-5">
            <p className="text-xs opacity-60">{label}</p>
            <p className="font-display text-2xl mt-1">{value}</p>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Day (IST)</th>
              <th>Invoices</th>
              <th>Gross</th>
              <th>Commission</th>
              <th>Partner payout</th>
            </tr>
          </thead>
          <tbody>
            {(settlements.data?.days ?? []).map((row) => (
              <tr key={row.settlement_date} className="border-t border-line">
                <td className="p-3">{row.settlement_date}</td>
                <td>{row.invoices}</td>
                <td>{rupees(Number(row.gross_paise))}</td>
                <td>{rupees(Number(row.commission_paise))}</td>
                <td className="font-medium">{rupees(Number(row.partner_paise))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!settlements.isLoading && !settlements.data?.days.length && (
          <p className="p-6 text-sm opacity-60">No captured invoices in this period.</p>
        )}
      </div>

      <div className="card overflow-x-auto">
        <div className="p-5 pb-0">
          <p className="font-semibold">Online payment attempts</p>
          <p className="text-xs opacity-60 mt-1">
            Manual rows record pay-at-salon intent only. Gateway rows are real Razorpay orders when credentials are set.
          </p>
        </div>
        <table className="w-full text-sm min-w-[820px] mt-3">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Created</th>
              <th>Provider</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Booking</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(payments.data?.payments ?? []).map((p: any) => (
              <tr key={p.id} className="border-t border-line">
                <td className="p-3 text-xs">{new Date(p.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                <td>{p.provider}</td>
                <td>{rupees(Number(p.amount_paise))}</td>
                <td><span className="chip !py-0.5 !px-2">{p.status}</span></td>
                <td className="text-xs opacity-60">{p.booking_id ? p.booking_id.slice(0, 8) : '—'}</td>
                <td className="pr-3 text-right">
                  {p.status === 'PAID' && (
                    <button onClick={() => doRefund(p.id, Number(p.amount_paise))} className="chip !py-1 !px-3" disabled={refund.isPending}>
                      Refund
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!payments.isLoading && !payments.data?.payments.length && (
          <p className="p-6 text-sm opacity-60">No online payment attempts yet.</p>
        )}
      </div>

      {settlements.data?.note && <p className="text-[11px] opacity-50">{settlements.data.note}</p>}
    </div>
  );
}
