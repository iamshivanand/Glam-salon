'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  rupees,
  useAdminKyc,
  useAdminSalons,
  useAdminStats,
  useAdminUsers,
  useReviewKyc,
  useUpdateCommission,
} from '@/lib/api';
import { useAuth, useAuthModal } from '@/lib/store';

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
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

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
                <td className="text-xs opacity-60 max-w-[180px] truncate">{row.shop_license_s3_key ?? 'not uploaded'}</td>
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

      <section className="card overflow-x-auto">
        <div className="p-5 pb-0">
          <h2 className="font-semibold">Salons</h2>
        </div>
        <table className="w-full text-sm min-w-[820px] mt-3">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Salon</th>
              <th>Owner</th>
              <th>Status</th>
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
        <div className="mt-3 space-y-1">
          {(users.data?.users ?? []).slice(0, 12).map((u: any) => (
            <div key={u.id} className="flex items-center justify-between border-t border-line pt-1 text-sm">
              <span>{u.full_name}</span>
              <span className="text-xs opacity-60">{u.role}</span>
              <span className="chip !py-0.5 !px-2">{u.status}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
