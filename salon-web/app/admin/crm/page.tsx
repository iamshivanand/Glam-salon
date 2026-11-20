'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  usePartnerCrm,
  usePartnerCrmDetail,
  useUpdateCrm,
  useUpdateStyleVault,
  usePartnerStaff,
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
  const { data: staffData } = usePartnerStaff();
  const update = useUpdateCrm();
  const updateVault = useUpdateStyleVault();

  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const crm = data?.crm;

  const [staffId, setStaffId] = useState('');
  const [haircut, setHaircut] = useState('');
  const [beard, setBeard] = useState('');
  const [guard, setGuard] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (crm) {
      const p = (crm.style_preferences_json ?? {}) as Record<string, any>;
      setHaircut(p.haircut ?? '');
      setBeard(p.beard ?? '');
      setGuard(p.guard_size ?? '');
      setNotes(p.notes ?? '');
      setStaffId(crm.preferred_staff_id ?? '');
    }
  }, [crm]);

  if (isLoading) return <p className="text-sm opacity-60">Loading customer…</p>;
  if (!crm) return <p className="text-sm opacity-60">Customer not found.</p>;

  const saveSegmentAndCode = async (body: { retention_segment?: CrmCustomer['retention_segment']; custom_customer_code?: string }) => {
    setNotice(null);
    setErrorNotice(null);
    try {
      await update.mutateAsync({ customerId, ...body });
      setNotice('Customer profile saved');
    } catch (err: any) {
      setErrorNotice(err.message);
    }
  };

  const saveStyleVault = async () => {
    setNotice(null);
    setErrorNotice(null);
    try {
      await updateVault.mutateAsync({
        customerId,
        preferred_staff_id: staffId || null,
        style_preferences: {
          haircut: haircut.trim() || undefined,
          beard: beard.trim() || undefined,
          guard_size: guard.trim() || undefined,
          notes: notes.trim() || undefined,
        },
      });
      setNotice('Haircut & style preferences saved to vault');
    } catch (err: any) {
      setErrorNotice(err.message);
    }
  };

  const onPhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setNotice(null);
    setErrorNotice(null);
    setUploading(true);
    try {
      const res = await updateVault.mutateAsync({
        customerId,
        request_photo_upload_count: 1,
      });
      const upload = res.upload_urls?.[0];
      if (!upload) throw new Error('No upload target generated');

      const putRes = await fetch(upload.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'image/jpeg' },
        body: file,
      });
      if (!putRes.ok) throw new Error(`Photo upload failed (${putRes.status})`);

      await updateVault.mutateAsync({
        customerId,
        uploaded_photo_keys: [upload.key],
      });
      setNotice('Reference photo uploaded successfully');
    } catch (err: any) {
      setErrorNotice(err.message);
    } finally {
      setUploading(false);
      e.target.value = '';
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

      {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-xs px-3 py-2">{notice}</div>}
      {errorNotice && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-xs px-3 py-2">{errorNotice}</div>}

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
            onChange={(e) => saveSegmentAndCode({ retention_segment: e.target.value as CrmCustomer['retention_segment'] })}
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
            <button onClick={() => code.trim() && saveSegmentAndCode({ custom_customer_code: code.trim() })} className="chip !py-2">Save</button>
          </div>
        </label>
      </div>

      {/* Style Vault Section */}
      <div className="border border-line rounded-2xl p-4 space-y-3 bg-surface-raised/40">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-sm flex items-center gap-2">
            <span>✂️</span> Haircut & Style Preferences Vault
          </p>
          <span className="text-[11px] opacity-60">Salon-Specific Style Profile</span>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 text-xs">
          <div>
            <label className="block text-[10px] opacity-60 mb-1">Preferred Stylist</label>
            <select
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              className="w-full border border-line rounded-xl px-3 py-2 bg-transparent text-xs"
            >
              <option value="">No preference</option>
              {(staffData?.staff ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.display_name} ({s.specialization ?? 'Stylist'})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] opacity-60 mb-1">Guard Size / Blade</label>
            <input
              value={guard}
              onChange={(e) => setGuard(e.target.value)}
              placeholder="e.g. #1.5 (4.5mm) on sides"
              className="w-full border border-line rounded-xl px-3 py-2 bg-transparent text-xs"
            />
          </div>
          <div>
            <label className="block text-[10px] opacity-60 mb-1">Haircut Style</label>
            <input
              value={haircut}
              onChange={(e) => setHaircut(e.target.value)}
              placeholder="e.g. Low drop fade, scissor cut top"
              className="w-full border border-line rounded-xl px-3 py-2 bg-transparent text-xs"
            />
          </div>
          <div>
            <label className="block text-[10px] opacity-60 mb-1">Beard Trim / Shape</label>
            <input
              value={beard}
              onChange={(e) => setBeard(e.target.value)}
              placeholder="e.g. Short boxed beard with sharp line-up"
              className="w-full border border-line rounded-xl px-3 py-2 bg-transparent text-xs"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-[10px] opacity-60 mb-1">Stylist Notes</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Cowlick at the crown, sensitive neckline, avoids chemical toners"
              className="w-full border border-line rounded-xl px-3 py-2 bg-transparent text-xs"
            />
          </div>
        </div>

        <button
          onClick={saveStyleVault}
          disabled={updateVault.isPending}
          className="btn-primary !py-1.5 !px-4 text-xs"
        >
          {updateVault.isPending ? 'Saving…' : 'Save Style Preferences'}
        </button>

        {/* Reference Photos */}
        <div className="pt-2 border-t border-line/60">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium">Consented Reference Photos</span>
            {crm.photo_consent_granted ? (
              <span className="text-[10px] text-green-700 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
                ✓ Consent Granted
              </span>
            ) : (
              <span className="text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                🔒 Consent Required
              </span>
            )}
          </div>

          {crm.photo_consent_granted ? (
            <div className="space-y-3">
              <div className="flex gap-2 flex-wrap">
                {(crm.reference_photos ?? []).map((photo, idx) => (
                  <div key={photo.key || idx} className="relative group rounded-xl overflow-hidden border border-line w-20 h-20 bg-background/80">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo.url} alt={`Reference ${idx + 1}`} className="w-full h-full object-cover" />
                  </div>
                ))}
                {(!crm.reference_photos || crm.reference_photos.length === 0) && (
                  <p className="text-xs opacity-50 py-2">No reference photographs saved yet.</p>
                )}
              </div>
              <div>
                <label className="chip !py-1.5 cursor-pointer text-xs">
                  {uploading ? 'Uploading photo…' : '+ Upload Reference Photo'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    disabled={uploading}
                    onChange={onPhotoSelected}
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-800 space-y-1">
              <p className="font-medium">Photo Storage Consent Required</p>
              <p className="opacity-80 text-[11px]">
                Under platform data privacy guidelines, reference photographs cannot be uploaded or viewed until the customer grants <code>STYLE_PHOTO_STORAGE</code> consent in their profile choices.
              </p>
            </div>
          )}
        </div>
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
