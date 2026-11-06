'use client';

import { useMemo, useState } from 'react';
import {
  usePartnerCrm,
  usePartnerCrmDetail,
  useUpdateCrm,
  rupees,
  type CrmCustomer,
} from '@/lib/api';
import { useAuth } from '@/lib/store';

const SEGMENTS: CrmCustomer['retention_segment'][] = ['NEW', 'REGULAR', 'AT_RISK', 'INACTIVE'];

function SegmentChip({ segment }: { segment: CrmCustomer['retention_segment'] }) {
  const tone =
    segment === 'REGULAR'
      ? 'border-green-300 text-green-700'
      : segment === 'AT_RISK'
        ? 'border-amber-300 text-amber-700'
        : segment === 'INACTIVE'
          ? 'border-red-300 text-red-700'
          : 'border-line';
  return <span className={`text-[10px] px-2 py-0.5 rounded-full border ${tone}`}>{segment}</span>;
}

function CrmDetail({ customerId }: { customerId: string }) {
  const { data, isLoading } = usePartnerCrmDetail(customerId);
  const update = useUpdateCrm();
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const crm = data?.crm;
  if (isLoading) return <p className="text-sm opacity-60">Loading customer…</p>;
  if (!crm) return <p className="text-sm opacity-60">Customer not found.</p>;

  const save = async (body: { retention_segment?: CrmCustomer['retention_segment']; custom_customer_code?: string }) => {
    setNotice(null);
    try {
      await update.mutateAsync({ customerId, ...body });
      setNotice('Saved');
    } catch (err: any) {
      setNotice(err.message);
    }
  };

  return (
    <div className="card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-2xl">{crm.customer_name}</p>
          <p className="text-xs opacity-60">
            {crm.custom_customer_code} · last visit {new Date(crm.last_visit_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
          </p>
        </div>
        <SegmentChip segment={crm.retention_segment} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        {[
          ['Visits', crm.total_visits],
          ['Lifetime spend', rupees(crm.total_spend_paise)],
          ['Average bill', rupees(crm.avg_bill_paise)],
          ['Loyalty points', crm.loyalty_points_balance],
        ].map(([label, value]) => (
          <div key={String(label)} className="border border-line rounded-xl p-3">
            <p className="text-[11px] opacity-60">{label}</p>
            <p className="font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs opacity-60">
          Segment
          <select
            value={crm.retention_segment}
            onChange={(e) => save({ retention_segment: e.target.value as CrmCustomer['retention_segment'] })}
            className="block mt-1 border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
          >
            {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-xs opacity-60">
          Customer code
          <div className="flex gap-2 mt-1">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={crm.custom_customer_code}
              className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
            />
            <button onClick={() => code.trim() && save({ custom_customer_code: code.trim() })} className="chip !py-2">Save</button>
          </div>
        </label>
        {notice && <span className="text-xs opacity-60">{notice}</span>}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div>
          <p className="font-semibold mb-2">Recent visits</p>
          <div className="space-y-2 max-h-64 overflow-auto">
            {(data?.visits ?? []).map((v) => (
              <div key={v.id} className="flex justify-between gap-2 border-b border-line py-1.5 text-sm">
                <span>
                  {v.booking_code}
                  <span className="block text-[11px] opacity-60">
                    {new Date(v.scheduled_start_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
                  </span>
                </span>
                <span className="text-right">
                  {rupees(v.total_payable_paise)}
                  <span className="block text-[10px] opacity-60">{v.status}</span>
                </span>
              </div>
            ))}
            {!data?.visits.length && <p className="text-sm opacity-60">No visits yet.</p>}
          </div>
        </div>
        <div>
          <p className="font-semibold mb-2">Loyalty ledger</p>
          <div className="space-y-2 max-h-64 overflow-auto">
            {(data?.ledger ?? []).map((l) => (
              <div key={l.id} className="flex justify-between gap-2 border-b border-line py-1.5 text-sm">
                <span>
                  {l.entry_type.replaceAll('_', ' ').toLowerCase()}
                  <span className="block text-[10px] opacity-60">balance {l.balance_after}</span>
                </span>
                <span className={l.amount_delta >= 0 ? 'text-green-700' : 'text-red-700'}>
                  {l.amount_delta >= 0 ? '+' : ''}{l.amount_delta}
                </span>
              </div>
            ))}
            {!data?.ledger.length && <p className="text-sm opacity-60">No ledger entries.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminCrm() {
  const { user } = useAuth();
  const { data, isLoading } = usePartnerCrm(!!user);
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const customers = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.customers ?? []).filter(
      (c) =>
        (!segment || c.retention_segment === segment) &&
        (!needle ||
          c.customer_name.toLowerCase().includes(needle) ||
          c.custom_customer_code.toLowerCase().includes(needle)),
    );
  }, [data?.customers, q, segment]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-4xl">Customers</h1>
        <p className="text-sm opacity-60 mt-1">Tenant-isolated CRM with visits, spend and loyalty.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or code"
          className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm flex-1 min-w-[200px]"
        />
        <select
          value={segment}
          onChange={(e) => setSegment(e.target.value)}
          className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
        >
          <option value="">All segments</option>
          {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {isLoading && <p>Loading customers…</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Customer</th>
              <th>Segment</th>
              <th>Visits</th>
              <th>Lifetime spend</th>
              <th>Avg interval</th>
              <th>Last visit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className={`border-t border-line ${selected === c.customer_id ? 'bg-black/5' : ''}`}>
                <td className="p-3">
                  <p className="font-medium">{c.customer_name}</p>
                  <p className="text-[11px] opacity-60">{c.custom_customer_code}</p>
                </td>
                <td><SegmentChip segment={c.retention_segment} /></td>
                <td>{c.total_visits}</td>
                <td>{rupees(c.total_spend_paise)}</td>
                <td>{c.computed_visit_interval_days} days</td>
                <td>{new Date(c.last_visit_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                <td className="pr-3 text-right">
                  <button onClick={() => setSelected(c.customer_id)} className="text-xs underline opacity-60 hover:opacity-100">
                    {selected === c.customer_id ? 'Selected' : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && !customers.length && <p className="p-6 text-sm opacity-60">No customers match this filter.</p>}
      </div>

      {selected && <CrmDetail customerId={selected} />}
    </div>
  );
}
