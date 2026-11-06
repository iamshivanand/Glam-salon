'use client';

import { usePartnerInvoices, rupees } from '@/lib/api';
import { useAuth } from '@/lib/store';

export default function AdminInvoices() {
  const { user } = useAuth();
  const { data, isLoading } = usePartnerInvoices(!!user);
  const totals = data?.totals;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-4xl">Invoices</h1>
        <p className="text-sm opacity-60 mt-1">Collected bills, GST and platform commission.</p>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        {[
          ['Net collected', totals?.net],
          ['Platform commission', totals?.commission],
          ['Partner settlement', totals?.settlement],
        ].map(([label, value]) => (
          <div key={String(label)} className="card p-5">
            <p className="text-xs opacity-60">{label}</p>
            <p className="font-display text-3xl mt-1">{rupees(Number(value ?? 0))}</p>
          </div>
        ))}
      </div>

      {isLoading && <p>Loading invoices…</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Invoice</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Method</th>
              <th>Gross</th>
              <th>Tax</th>
              <th>Net</th>
              <th>Commission</th>
              <th>Settlement</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(data?.invoices ?? []).map((i: any) => (
              <tr key={i.id} className="border-t border-line">
                <td className="p-3 font-medium">{i.invoice_number}</td>
                <td>{new Date(i.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                <td>{i.customer_name}</td>
                <td><span className="chip !py-0.5 !px-2">{i.method}</span></td>
                <td>{rupees(i.gross_amount_paise)}</td>
                <td>{rupees(i.tax_paise)}</td>
                <td>{rupees(i.net_collected_paise)}</td>
                <td>{rupees(i.platform_commission_paise)}</td>
                <td>{rupees(i.partner_net_settlement_paise)}</td>
                <td>{i.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && !data?.invoices.length && <p className="p-6 text-sm opacity-60">No invoices yet.</p>}
      </div>

      <p className="text-xs opacity-50">
        Payments are recorded at the salon. Online gateway capture and refunds are not connected yet.
      </p>
    </div>
  );
}
