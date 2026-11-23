'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  fetchKycDocumentUrl,
  rupees,
  useAdminAudit,
  useAdminDisputes,
  useAdminKyc,
  useAdminSalons,
  useAdminStats,
  useAdminUsers,
  useRecordPayout,
  useReviewKyc,
  useSetSalonStatus,
  useUpdateAdminUser,
  useUpdateCommission,
  useUpdateDispute,
} from '@/lib/api';
import { useAuth, useAuthModal } from '@/lib/store';

function monthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function PlatformPage() {
  const { user, hydrated } = useAuth();
  const { openModal } = useAuthModal();
  const isAdmin = user?.role === 'PLATFORM_ADMIN';
  const stats = useAdminStats(isAdmin);
  const kyc = useAdminKyc(undefined, isAdmin);
  const salons = useAdminSalons(isAdmin);
  const users = useAdminUsers(isAdmin);
  const review = useReviewKyc();
  const commission = useUpdateCommission();
  const [disputeFilter, setDisputeFilter] = useState<'OPEN_ALERT' | 'ESCALATED' | 'RESOLVED' | 'ALL'>('OPEN_ALERT');
  const disputes = useAdminDisputes(disputeFilter, isAdmin);
  const updateDispute = useUpdateDispute();
  const salonStatus = useSetSalonStatus();
  const adminUser = useUpdateAdminUser();
  const payout = useRecordPayout();
  const audit = useAdminAudit(isAdmin);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [payoutForm, setPayoutForm] = useState({
    salonId: '',
    period_start: monthStart(),
    period_end: todayIso(),
    amount: '',
    reference: '',
  });

  if (!hydrated) return <div className="card p-8 mt-8">Checking your session…</div>;
  if (!user) {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <h1 className="font-display text-3xl">Platform administration</h1>
        <p className="opacity-70 mt-2">Sign in with the platform admin account.</p>
        <button onClick={() => openModal('Sign in with the platform admin account.')} className="btn-primary mt-5">
          Sign in
        </button>
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <h1 className="font-display text-3xl">Platform administrators only</h1>
        <p className="opacity-70 mt-2">Your account does not have the PLATFORM_ADMIN role.</p>
        <Link href="/admin" className="chip !py-2 inline-block mt-4">Back to salon console</Link>
      </div>
    );
  }

  const decide = async (salonId: string, decision: 'APPROVED' | 'REJECTED' | 'UNDER_REVIEW') => {
    setNotice(null);
    setProblem(null);
    try {
      await review.mutateAsync({ salonId, decision, rejection_reason: reasons[salonId] });
      setNotice(`KYC ${decision.toLowerCase()} for salon ${salonId.slice(0, 8)}…`);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const setCommission = async (salonId: string, bps: number) => {
    setNotice(null);
    setProblem(null);
    try {
      await commission.mutateAsync({ salonId, marketplace_new_client_bps: bps });
      setNotice('Commission updated.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const handleUpdateDispute = async (id: string, resolution_status: string) => {
    setNotice(null);
    setProblem(null);
    try {
      await updateDispute.mutateAsync({ id, resolution_status });
      setNotice(`Dispute status updated to ${resolution_status.toLowerCase().replaceAll('_', ' ')}.`);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const toggleSalon = async (salonId: string, isActive: boolean) => {
    setNotice(null);
    setProblem(null);
    const reason = isActive ? undefined : window.prompt('Why is this salon being deactivated?') ?? undefined;
    try {
      await salonStatus.mutateAsync({ salonId, is_active: isActive, reason });
      setNotice(isActive ? 'Salon activated.' : 'Salon deactivated.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const changeUser = async (
    userId: string,
    body: { status?: 'ACTIVE' | 'SUSPENDED' | 'DELETED'; role?: string },
  ) => {
    setNotice(null);
    setProblem(null);
    try {
      await adminUser.mutateAsync({ userId, ...body });
      setNotice('User updated.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const viewDocument = async (salonId: string) => {
    setNotice(null);
    setProblem(null);
    try {
      const url = await fetchKycDocumentUrl(salonId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const savePayout = async () => {
    setNotice(null);
    setProblem(null);
    if (!payoutForm.salonId) return setProblem('Choose a salon for this payout.');
    const amount = Math.round(Number(payoutForm.amount) * 100);
    if (!Number.isFinite(amount) || amount <= 0) return setProblem('Enter a payout amount in rupees.');
    try {
      await payout.mutateAsync({
        salonId: payoutForm.salonId,
        period_start: payoutForm.period_start,
        period_end: payoutForm.period_end,
        amount_paise: amount,
        reference: payoutForm.reference || undefined,
      });
      setNotice('Payout recorded.');
      setPayoutForm({ ...payoutForm, amount: '', reference: '' });
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  return (
    <div className="pt-8 max-w-6xl mx-auto space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-accent">Platform</p>
          <h1 className="font-display text-4xl mt-1">Marketplace control room</h1>
          <p className="text-sm opacity-60 mt-1">KYC review, salon status, commission and marketplace health.</p>
        </div>
        <Link href="/admin" className="chip !py-2">Salon console</Link>
      </div>

      {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">{notice}</div>}
      {problem && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{problem}</div>}

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          ['Salons', stats.data?.salons.total ?? 0],
          ['Approved', stats.data?.salons.approved ?? 0],
          ['Pending KYC', stats.data?.salons.pending ?? 0],
          ['Customers', stats.data?.users.customers ?? 0],
        ].map(([label, value]) => (
          <div key={String(label)} className="card p-5">
            <p className="text-xs opacity-60">{label}</p>
            <p className="font-display text-3xl mt-1">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="card p-5">
          <p className="text-xs opacity-60">Captured GMV</p>
          <p className="font-display text-2xl mt-1">{rupees(Number(stats.data?.gmv.gmv ?? 0))}</p>
        </div>
        <div className="card p-5">
          <p className="text-xs opacity-60">Platform commission</p>
          <p className="font-display text-2xl mt-1">{rupees(Number(stats.data?.gmv.commission ?? 0))}</p>
        </div>
      </div>

      <section className="card overflow-x-auto">
        <div className="p-5 pb-0">
          <h2 className="font-semibold">KYC review queue</h2>
          <p className="text-xs opacity-60 mt-1">Approve only after PAN, bank and licence details are checked.</p>
        </div>
        <table className="w-full text-sm min-w-[900px] mt-3">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Salon</th>
              <th>GSTIN</th>
              <th>IFSC</th>
              <th>Licence</th>
              <th>Status</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {(kyc.data?.submissions ?? []).map((row: any) => (
              <tr key={row.id} className="border-t border-line align-top">
                <td className="p-3 font-medium">{row.salon_name}</td>
                <td>{row.gstin ?? '—'}</td>
                <td>{row.bank_ifsc}</td>
                <td className="text-xs opacity-60 max-w-[180px]">
                  {row.shop_license_s3_key ? (
                    <button onClick={() => viewDocument(row.salon_id)} className="underline">
                      View document
                    </button>
                  ) : (
                    'not uploaded'
                  )}
                </td>
                <td><span className="chip !py-0.5 !px-2">{row.kyc_status}</span></td>
                <td className="py-2 pr-3">
                  <div className="flex flex-wrap gap-1">
                    <button onClick={() => decide(row.salon_id, 'APPROVED')} className="chip !py-1 !px-2">Approve</button>
                    <button onClick={() => decide(row.salon_id, 'UNDER_REVIEW')} className="chip !py-1 !px-2">Review</button>
                  </div>
                  <input
                    placeholder="Rejection reason"
                    value={reasons[row.salon_id] ?? ''}
                    onChange={(e) => setReasons({ ...reasons, [row.salon_id]: e.target.value })}
                    className="mt-1 w-full border border-line rounded-xl px-2 py-1 bg-transparent text-xs"
                  />
                  <button onClick={() => decide(row.salon_id, 'REJECTED')} className="chip !py-1 !px-2 mt-1">Reject</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!kyc.data?.submissions.length && <p className="p-6 text-sm opacity-60">No KYC submissions.</p>}
      </section>

      {/* Escalated Complaints & Disputes (Ticket 15 - F1.15 - API-38) */}
      <section className="card overflow-x-auto">
        <div className="p-5 pb-0 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <span>⚠️</span> Escalated Complaints & Disputes (API-38)
            </h2>
            <p className="text-xs opacity-60 mt-1">
              Low-rating customer reviews (≤ 2 stars) and partner escalations across salons.
            </p>
          </div>
          <div className="flex gap-1 bg-surface-raised/40 p-0.5 rounded-lg border border-line text-xs">
            {(['OPEN_ALERT', 'ESCALATED', 'RESOLVED', 'ALL'] as const).map((st) => (
              <button
                key={st}
                onClick={() => setDisputeFilter(st)}
                className={`px-2.5 py-0.5 rounded-md transition ${disputeFilter === st ? 'bg-accent text-[#2D1B2E] font-medium' : 'opacity-60 hover:opacity-100'}`}
              >
                {st === 'OPEN_ALERT' ? 'Open Alerts' : st === 'ESCALATED' ? 'Escalated' : st === 'RESOLVED' ? 'Resolved' : 'All'}
              </button>
            ))}
          </div>
        </div>

        <table className="w-full text-sm min-w-[950px] mt-3">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Booking / Date</th>
              <th>Customer</th>
              <th>Salon / Stylist</th>
              <th>Ratings</th>
              <th>AI Tags</th>
              <th>Feedback</th>
              <th>Status / Action</th>
            </tr>
          </thead>
          <tbody>
            {(disputes.data?.disputes ?? []).map((d) => (
              <tr key={d.id} className="border-t border-line align-top text-xs">
                <td className="p-3 font-medium whitespace-nowrap">
                  <div>#{d.booking_code}</div>
                  <div className="opacity-50 text-[11px]">{new Date(d.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
                </td>
                <td>
                  <span className="font-medium">{d.customer_name}</span>
                </td>
                <td>
                  <div><b>{d.salon_name}</b></div>
                  <div className="opacity-50 text-[11px]">{d.salon_locality} · Stylist: {d.staff_name ?? '—'}</div>
                </td>
                <td className="whitespace-nowrap">
                  <div className="font-semibold text-amber-500">★ {d.overall_rating}/5</div>
                  <div className="text-[11px] opacity-60">Hygiene: {d.hygiene_rating}/5</div>
                </td>
                <td>
                  <div className="flex flex-wrap gap-1 max-w-[160px]">
                    {d.ai_complaint_tags?.length ? (
                      d.ai_complaint_tags.map((tag) => (
                        <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 font-medium">
                          {tag}
                        </span>
                      ))
                    ) : (
                      <span className="opacity-40 text-[11px]">None</span>
                    )}
                  </div>
                </td>
                <td className="max-w-[240px]">
                  <p className="italic opacity-80 line-clamp-3" title={d.review_text ?? ''}>{d.review_text || 'No text review'}</p>
                  {d.owner_reply && (
                    <p className="mt-1 text-[11px] bg-white/5 p-1.5 rounded-lg border border-line/40">
                      <b className="opacity-60 block">Owner reply:</b> {d.owner_reply}
                    </p>
                  )}
                </td>
                <td className="p-2 whitespace-nowrap">
                  <span className={`chip !py-0.5 !px-2 mb-2 inline-block ${
                    d.resolution_status === 'OPEN_ALERT'
                      ? '!bg-amber-100 !text-amber-800 !border-amber-300'
                      : d.resolution_status === 'ESCALATED'
                      ? '!bg-red-100 !text-red-800 !border-red-300'
                      : '!bg-green-100 !text-green-800 !border-green-300'
                  }`}>
                    {d.resolution_status}
                  </span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {d.resolution_status !== 'RESOLVED' && (
                      <button
                        onClick={() => handleUpdateDispute(d.id, 'RESOLVED')}
                        disabled={updateDispute.isPending}
                        className="text-[10px] px-2 py-0.5 rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700"
                      >
                        Resolve
                      </button>
                    )}
                    {d.resolution_status !== 'ESCALATED' && (
                      <button
                        onClick={() => handleUpdateDispute(d.id, 'ESCALATED')}
                        disabled={updateDispute.isPending}
                        className="text-[10px] px-2 py-0.5 rounded-md border border-red-400 text-red-400 hover:bg-red-500/10"
                      >
                        Escalate
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!disputes.isLoading && (!disputes.data?.disputes || disputes.data.disputes.length === 0) && (
          <p className="p-6 text-sm opacity-60 text-center">No escalated complaints in this status.</p>
        )}
      </section>

      <section className="card overflow-x-auto">
        <div className="p-5 pb-0">
          <h2 className="font-semibold">Salons</h2>
        </div>
        <table className="w-full text-sm min-w-[940px] mt-3">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Salon</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Live</th>
              <th>Rating</th>
              <th>Marketplace commission</th>
            </tr>
          </thead>
          <tbody>
            {(salons.data?.salons ?? []).map((s: any) => (
              <tr key={s.id} className="border-t border-line">
                <td className="p-3">
                  <b>{s.name}</b>
                  <span className="block text-xs opacity-50">{s.locality}, {s.city}</span>
                </td>
                <td>{s.owner_name}</td>
                <td><span className="chip !py-0.5 !px-2">{s.verification_status}</span></td>
                <td>
                  <button
                    onClick={() => toggleSalon(s.id, !s.is_active)}
                    disabled={salonStatus.isPending}
                    className="chip !py-0.5 !px-2"
                  >
                    {s.is_active ? 'Active' : 'Paused'}
                  </button>
                </td>
                <td>★ {Number(s.avg_rating ?? 0).toFixed(1)} ({s.review_count})</td>
                <td>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={Number(s.marketplace_new_client_bps ?? 1500) / 100}
                      className="w-20 border border-line rounded-xl px-2 py-1 bg-transparent text-xs"
                      onBlur={(e) => {
                        if (e.target.value.trim() === '') return;
                        const next = Math.round(Number(e.target.value) * 100);
                        if (Number.isFinite(next) && next !== Number(s.marketplace_new_client_bps ?? 1500)) {
                          setCommission(s.id, next);
                        }
                      }}
                    />
                    <span className="text-xs opacity-50">% new client</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card p-5">
        <h2 className="font-semibold">Recent users</h2>
        <p className="text-xs opacity-60 mt-1">
          Role changes take effect on the next sign-in. Suspending an account revokes all its sessions immediately.
        </p>
        <div className="mt-3 space-y-1">
          {(users.data?.users ?? []).slice(0, 12).map((u: any) => (
            <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-sm">
              <span className="min-w-[140px]">{u.full_name}</span>
              <span className="text-xs opacity-60">{u.email ?? 'no email'}</span>
              <select
                value={u.role}
                disabled={u.id === user.id || adminUser.isPending}
                onChange={(e) => changeUser(u.id, { role: e.target.value })}
                className="border border-line rounded-xl px-2 py-1 bg-transparent text-xs"
              >
                {['CUSTOMER', 'SALON_OWNER', 'SALON_MANAGER', 'STAFF', 'PLATFORM_ADMIN'].map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
              <span className="chip !py-0.5 !px-2">{u.status}</span>
              {u.id !== user.id && (
                <button
                  onClick={() => changeUser(u.id, { status: u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' })}
                  disabled={adminUser.isPending}
                  className="chip !py-1 !px-2 text-xs"
                >
                  {u.status === 'ACTIVE' ? 'Suspend' : 'Activate'}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Record a payout</h2>
        <p className="text-xs opacity-60">
          Payout execution is manual: record the bank transfer here after paying a salon for a period.
        </p>
        <div className="grid sm:grid-cols-2 xl:grid-cols-5 gap-2">
          <select
            value={payoutForm.salonId}
            onChange={(e) => setPayoutForm({ ...payoutForm, salonId: e.target.value })}
            className="border border-line rounded-xl px-2 py-2 bg-transparent text-sm"
          >
            <option value="">Choose salon</option>
            {(salons.data?.salons ?? []).map((s: any) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            type="date"
            value={payoutForm.period_start}
            onChange={(e) => setPayoutForm({ ...payoutForm, period_start: e.target.value })}
            className="border border-line rounded-xl px-2 py-2 bg-transparent text-sm"
          />
          <input
            type="date"
            value={payoutForm.period_end}
            onChange={(e) => setPayoutForm({ ...payoutForm, period_end: e.target.value })}
            className="border border-line rounded-xl px-2 py-2 bg-transparent text-sm"
          />
          <input
            placeholder="Amount (₹)"
            inputMode="decimal"
            value={payoutForm.amount}
            onChange={(e) => setPayoutForm({ ...payoutForm, amount: e.target.value })}
            className="border border-line rounded-xl px-2 py-2 bg-transparent text-sm"
          />
          <input
            placeholder="UTR / reference"
            value={payoutForm.reference}
            onChange={(e) => setPayoutForm({ ...payoutForm, reference: e.target.value })}
            className="border border-line rounded-xl px-2 py-2 bg-transparent text-sm"
          />
        </div>
        <button onClick={savePayout} disabled={payout.isPending} className="btn-primary !py-2 !px-4 text-sm">
          {payout.isPending ? 'Recording…' : 'Record payout'}
        </button>
      </section>

      <section className="card p-5">
        <h2 className="font-semibold">Admin audit log</h2>
        <div className="mt-3 space-y-1">
          {(audit.data?.events ?? []).slice(0, 20).map((event) => (
            <div key={event.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-1 text-xs">
              <span className="opacity-60">
                {new Date(event.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
              </span>
              <span>{event.action}</span>
              <span className="opacity-60">{event.salon_name ?? event.entity_type}</span>
              <span className="opacity-60">{event.actor_name ?? 'system'}</span>
            </div>
          ))}
          {!audit.data?.events.length && <p className="text-sm opacity-60">No admin actions recorded yet.</p>}
        </div>
      </section>
    </div>
  );
}
