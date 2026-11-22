'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  rupees,
  uploadFile,
  useAddAddress,
  useAddresses,
  useConsents,
  useCustomerLoyaltyLedger,
  useCustomerStyleVault,
  useDeleteAddress,
  useDeleteAccount,
  useMe,
  usePayments,
  useSetAvatar,
  useSetConsent,
  useUpdateAddress,
  useUpdateMe,
  useUploadStatus,
} from '@/lib/api';
import { useAuth, useAuthModal } from '@/lib/store';

const CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'] as const;
const PURPOSES = [
  ['RETENTION_REMINDER', 'Visit reminders'],
  ['PROMOTIONAL_OFFERS', 'Offers & promotions'],
  ['STYLE_PHOTO_STORAGE', 'Style photo storage'],
] as const;
const GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Other', 'Prefer not to say'] as const;

export default function AccountPage() {
  const { user, hydrated } = useAuth();
  const { openModal } = useAuthModal();
  const me = useMe(!!user);
  const updateMe = useUpdateMe();
  const consents = useConsents(!!user);
  const setConsent = useSetConsent();
  const addresses = useAddresses(!!user);
  const addAddress = useAddAddress();
  const deleteAddress = useDeleteAddress();
  const updateAddress = useUpdateAddress();
  const deleteAccount = useDeleteAccount();
  const setAvatar = useSetAvatar();
  const uploadStatus = useUploadStatus();
  const payments = usePayments(!!user);
  const styleVault = useCustomerStyleVault(!!user);
  const loyalty = useCustomerLoyaltyLedger(!!user);

  const [form, setForm] = useState({ full_name: '', email: '', gender: '', date_of_birth: '' });
  const [address, setAddress] = useState({
    label: 'Home',
    address_line: '',
    locality: '',
    city: 'Bengaluru',
    postal_code: '',
    lat: 12.9719,
    lng: 77.6412,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editingAddrId, setEditingAddrId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [genderOpen, setGenderOpen] = useState(false);
  const genderDropdownRef = useRef<HTMLDivElement>(null);
  const [ledgerFilter, setLedgerFilter] = useState<'ALL' | 'EARN' | 'REDEEM'>('ALL');

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (genderDropdownRef.current && !genderDropdownRef.current.contains(e.target as Node)) {
        setGenderOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!me.data) return;
    setForm({
      full_name: me.data.full_name ?? '',
      email: me.data.email ?? '',
      gender: me.data.gender ?? '',
      date_of_birth: me.data.date_of_birth?.slice(0, 10) ?? '',
    });
  }, [me.data]);

  if (!hydrated) return <div className="card p-8 mt-8">Checking your session…</div>;
  if (!user) {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <h1 className="font-display text-3xl">Your account</h1>
        <p className="opacity-70 mt-2">Sign in to manage your profile, communication choices and addresses.</p>
        <button onClick={() => openModal('Sign in to manage your account.')} className="btn-primary mt-5">
          Sign in
        </button>
      </div>
    );
  }

  const saveProfile = async () => {
    setNotice(null);
    setProblem(null);
    try {
      const payload: any = {
        full_name: form.full_name,
        gender: form.gender || undefined,
        date_of_birth: form.date_of_birth || undefined,
      };
      if (!me.data?.email && form.email) {
        payload.email = form.email;
      }
      await updateMe.mutateAsync(payload);
      setNotice('Profile saved.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const uploadAvatar = async (file: File) => {
    setNotice(null);
    setProblem(null);
    try {
      const uploaded = await uploadFile(file, 'avatar');
      await setAvatar.mutateAsync(uploaded.key);
      setNotice(uploaded.public_url ? 'Avatar uploaded.' : 'Avatar uploaded. Set S3_PUBLIC_BASE_URL to render it in the web app.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const saveAddress = async () => {
    setNotice(null);
    setProblem(null);
    try {
      if (editingAddrId) {
        await updateAddress.mutateAsync({ id: editingAddrId, ...address });
        setEditingAddrId(null);
        setNotice('Address updated.');
      } else {
        await addAddress.mutateAsync({ ...address, is_default: !addresses.data?.addresses.length });
        setNotice('Address saved.');
      }
      setAddress({ ...address, address_line: '', locality: '', postal_code: '' });
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const startEditAddress = (a: any) => {
    setEditingAddrId(a.id);
    setAddress({ label: a.label, address_line: a.address_line ?? '', locality: a.locality, city: a.city, postal_code: a.postal_code, lat: a.lat, lng: a.lng });
  };

  const handleDeleteAccount = async () => {
    setNotice(null);
    setProblem(null);
    try {
      await deleteAccount.mutateAsync();
      setNotice('Your account has been scheduled for deletion.');
      // sign out after short delay
      setTimeout(() => { window.location.href = '/'; }, 1500);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const consentState = (purpose: string, channel: string): boolean => {
    const rows = consents.data?.consents ?? [];
    const specific = rows.find((c) => c.purpose === purpose && c.channel === channel && c.salon_id === null);
    return specific?.is_granted ?? purpose === 'RETENTION_REMINDER';
  };

  return (
    <div className="pt-8 max-w-4xl mx-auto space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl">Your account</h1>
          <p className="text-sm opacity-60 mt-1">{me.data?.phone_masked ?? user.phone_masked ?? ''}</p>
        </div>
        <Link href="/appointments" className="chip !py-2">My visits</Link>
      </div>

      {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">{notice}</div>}
      {problem && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{problem}</div>}

      <section className="card p-6 space-y-4">
        <h2 className="font-semibold">Profile</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium opacity-60 block">Full name</label>
            <input
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm focus:outline-none focus:border-accent transition"
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium opacity-60 block">Email</label>
              {me.data?.email && (
                <span className="text-[10px] font-medium text-accent flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  Verified & locked
                </span>
              )}
            </div>
            <input
              type="email"
              value={form.email}
              disabled={!!me.data?.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className={`mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm transition ${
                me.data?.email
                  ? 'opacity-60 cursor-not-allowed bg-black/5 dark:bg-white/5'
                  : 'focus:outline-none focus:border-accent'
              }`}
            />
          </div>
          <div ref={genderDropdownRef} className="relative">
            <span className="text-xs font-medium opacity-60 block">Gender</span>
            <button
              type="button"
              onClick={() => setGenderOpen(!genderOpen)}
              className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm flex items-center justify-between text-left hover:border-accent/80 transition focus:outline-none focus:border-accent"
            >
              <span className={form.gender ? 'text-ink dark:text-white' : 'opacity-40'}>
                {form.gender || 'Select gender'}
              </span>
              <svg
                className={`w-4 h-4 opacity-50 transition-transform duration-200 ${genderOpen ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {genderOpen && (
              <div className="absolute left-0 right-0 z-30 mt-1.5 bg-surface border border-line rounded-xl shadow-[0_10px_30px_-10px_rgba(45,27,46,0.15)] p-1.5 space-y-0.5">
                {GENDER_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      setForm({ ...form, gender: opt });
                      setGenderOpen(false);
                    }}
                    className={`w-full px-3 py-2 text-sm rounded-lg flex items-center justify-between text-left transition ${
                      form.gender === opt
                        ? 'bg-accent/20 text-ink dark:text-white font-medium'
                        : 'hover:bg-accent/10 opacity-80 hover:opacity-100'
                    }`}
                  >
                    <span>{opt}</span>
                    {form.gender === opt && (
                      <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="text-xs font-medium opacity-60 block">Date of birth</label>
            <input
              type="date"
              value={form.date_of_birth}
              onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
              className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm focus:outline-none focus:border-accent transition"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={saveProfile} disabled={updateMe.isPending} className="btn-primary !py-2 !px-4 text-sm">
            {updateMe.isPending ? 'Saving…' : 'Save profile'}
          </button>
          <label className="chip !py-2 cursor-pointer">
            Upload avatar
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])}
            />
          </label>
          <span className="text-[11px] opacity-50">
            Storage: {uploadStatus.data?.configured ? uploadStatus.data.provider : 'not configured'}
          </span>
        </div>
        {!uploadStatus.data?.configured && (
          <p className="text-[11px] opacity-50">
            Avatar uploads require S3 configuration. The button will report a clear error until then.
          </p>
        )}
      </section>

      <section className="card p-6 space-y-3">
        <h2 className="font-semibold">Communication choices</h2>
        <p className="text-xs opacity-60">
          Transactional booking messages are separate. These switches control reminders and marketing.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[520px]">
            <thead>
              <tr className="text-left opacity-60">
                <th className="py-2">Purpose</th>
                {CHANNELS.map((c) => <th key={c}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {PURPOSES.map(([purpose, label]) => (
                <tr key={purpose} className="border-t border-line">
                  <td className="py-2">{label}</td>
                  {CHANNELS.map((channel) => (
                    <td key={channel}>
                      <input
                        type="checkbox"
                        checked={consentState(purpose, channel)}
                        onChange={(e) =>
                          setConsent.mutate({ purpose, channel, is_granted: e.target.checked })
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] opacity-50">
          Replying STOP to a WhatsApp or SMS reminder opts you out across salons immediately.
        </p>
      </section>

      <section className="card p-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <span>✂️</span> My Haircut & Style Preferences Vault
            </h2>
            <p className="text-xs opacity-60 mt-0.5">
              Your saved cut notes, guard numbers, and beard preferences recorded across salons.
            </p>
          </div>
          {styleVault.data?.photo_consent_granted ? (
            <span className="text-[10px] text-green-700 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
              ✓ Photo Storage Consented
            </span>
          ) : (
            <span className="text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
              🔒 Enable in Communication Choices
            </span>
          )}
        </div>

        {styleVault.isLoading && <p className="text-sm opacity-60">Loading your style profile…</p>}

        <div className="space-y-3">
          {(styleVault.data?.vaults ?? []).map((v) => {
            const prefs = (v.style_preferences_json ?? {}) as Record<string, any>;
            const hasPrefs = Boolean(prefs.haircut || prefs.beard || prefs.guard_size || prefs.notes || Object.keys(prefs).length > 0);
            return (
              <div key={v.salon_id} className="border border-line rounded-2xl p-4 bg-surface-raised/30 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-semibold text-sm">{v.salon_name}</p>
                    <p className="text-[11px] opacity-60">
                      {v.locality} · {v.total_visits} {v.total_visits === 1 ? 'visit' : 'visits'} · Last visit {new Date(v.last_visit_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
                    </p>
                  </div>
                  {v.preferred_staff_name && (
                    <span className="text-[11px] px-2.5 py-1 rounded-full border border-line bg-background">
                      Stylist: <b>{v.preferred_staff_name}</b>
                    </span>
                  )}
                </div>

                {hasPrefs ? (
                  <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-2 pt-2 text-xs">
                    {prefs.haircut && (
                      <div className="rounded-xl border border-line/60 bg-background/50 p-2.5">
                        <span className="text-[10px] uppercase tracking-wider opacity-50 block">Haircut Style</span>
                        <span className="font-medium mt-0.5 block">{prefs.haircut}</span>
                      </div>
                    )}
                    {prefs.beard && (
                      <div className="rounded-xl border border-line/60 bg-background/50 p-2.5">
                        <span className="text-[10px] uppercase tracking-wider opacity-50 block">Beard Style</span>
                        <span className="font-medium mt-0.5 block">{prefs.beard}</span>
                      </div>
                    )}
                    {prefs.guard_size && (
                      <div className="rounded-xl border border-line/60 bg-background/50 p-2.5">
                        <span className="text-[10px] uppercase tracking-wider opacity-50 block">Guard / Blade</span>
                        <span className="font-medium mt-0.5 block">{prefs.guard_size}</span>
                      </div>
                    )}
                    {prefs.notes && (
                      <div className="rounded-xl border border-line/60 bg-background/50 p-2.5 sm:col-span-2 md:col-span-1">
                        <span className="text-[10px] uppercase tracking-wider opacity-50 block">Stylist Notes</span>
                        <span className="font-medium mt-0.5 block truncate" title={prefs.notes}>{prefs.notes}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs opacity-50 italic py-1">No custom style notes recorded yet for this salon.</p>
                )}

                {v.reference_photos?.length > 0 && (
                  <div className="pt-2 border-t border-line/40">
                    <p className="text-[10px] uppercase tracking-wider opacity-50 mb-1.5">Reference Photographs</p>
                    <div className="flex gap-2 flex-wrap">
                      {v.reference_photos.map((photo, pIdx) => (
                        <div key={photo.key || pIdx} className="w-16 h-16 rounded-xl overflow-hidden border border-line">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={photo.url} alt={`Style photo ${pIdx + 1}`} className="w-full h-full object-cover" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {!styleVault.isLoading && (!styleVault.data?.vaults || styleVault.data.vaults.length === 0) && (
            <p className="text-sm opacity-60 py-2">
              No style preferences recorded yet. Once you complete visits at partner salons, your cut specifications and preferred stylists will appear here.
            </p>
          )}
        </div>
      </section>

      {/* Loyalty Points & Rewards Passbook (Ticket 14 - F1.14) */}
      <section className="card p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <span>⭐</span> Loyalty Points & Rewards Passbook
            </h2>
            <p className="text-xs opacity-60 mt-0.5">
              Earn 1 loyalty point per ₹100 spent on completed visits. Redeem points (1 pt = ₹1) directly at POS checkout.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/15 text-accent font-medium text-xs border border-accent/25">
              <span>🪙</span>
              <span>{loyalty.data?.total_points ?? 0} Points Available</span>
              <span className="opacity-60 text-[10px]">(₹{loyalty.data?.total_points ?? 0} Value)</span>
            </span>
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/5 border border-line text-[11px] opacity-70"
              title="Phase 2 Dual-Ledger Prepaid Wallet Ready"
            >
              <span>💳</span>
              <span>Wallet: ₹{((loyalty.data?.total_wallet_paise ?? 0) / 100).toFixed(0)}</span>
            </span>
          </div>
        </div>

        {loyalty.isLoading && <p className="text-sm opacity-60">Loading your loyalty ledger…</p>}

        {/* Salon Balance Breakdown */}
        {(loyalty.data?.balances?.length ?? 0) > 0 && (
          <div className="space-y-1.5">
            <span className="text-[11px] uppercase tracking-wider opacity-50 block font-medium">Points by Salon</span>
            <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-2">
              {loyalty.data?.balances.map((b) => (
                <div key={b.salon_id} className="border border-line/60 rounded-xl p-3 bg-surface-raised/20 flex items-center justify-between">
                  <div className="min-w-0 pr-2">
                    <p className="text-xs font-medium truncate">{b.salon_name}</p>
                    <p className="text-[10px] opacity-50 truncate">{b.locality} · {b.total_visits} {b.total_visits === 1 ? 'visit' : 'visits'}</p>
                  </div>
                  <span className="text-xs font-semibold text-accent whitespace-nowrap bg-accent/10 px-2 py-0.5 rounded-lg border border-accent/20">
                    {b.loyalty_points_balance} pts
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filter Tabs */}
        <div className="flex items-center justify-between pt-1 border-t border-line/40">
          <span className="text-xs font-medium opacity-70">Itemized Passbook</span>
          <div className="flex gap-1 bg-surface-raised/40 p-0.5 rounded-lg border border-line text-xs">
            <button
              onClick={() => setLedgerFilter('ALL')}
              className={`px-2.5 py-0.5 rounded-md transition ${ledgerFilter === 'ALL' ? 'bg-accent text-[#2D1B2E] font-medium' : 'opacity-60 hover:opacity-100'}`}
            >
              All
            </button>
            <button
              onClick={() => setLedgerFilter('EARN')}
              className={`px-2.5 py-0.5 rounded-md transition ${ledgerFilter === 'EARN' ? 'bg-accent text-[#2D1B2E] font-medium' : 'opacity-60 hover:opacity-100'}`}
            >
              Earned (+)
            </button>
            <button
              onClick={() => setLedgerFilter('REDEEM')}
              className={`px-2.5 py-0.5 rounded-md transition ${ledgerFilter === 'REDEEM' ? 'bg-accent text-[#2D1B2E] font-medium' : 'opacity-60 hover:opacity-100'}`}
            >
              Redeemed (-)
            </button>
          </div>
        </div>

        {/* Transaction History Feed */}
        <div className="space-y-2">
          {(loyalty.data?.entries ?? [])
            .filter((e) => {
              if (ledgerFilter === 'EARN') return e.amount_delta > 0;
              if (ledgerFilter === 'REDEEM') return e.amount_delta < 0;
              return true;
            })
            .map((e) => {
              const isEarn = e.amount_delta > 0;
              return (
                <div
                  key={e.id}
                  className="flex items-center justify-between border border-line/50 rounded-xl p-3 text-xs bg-background/40 hover:border-line transition"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{e.salon_name}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold tracking-wide ${
                          isEarn
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-amber-50 text-amber-700 border border-amber-200'
                        }`}
                      >
                        {e.entry_type === 'EARN_VISIT'
                          ? 'VISIT REWARD'
                          : e.entry_type === 'REDEEM_CHECKOUT'
                          ? 'CHECKOUT REDEMPTION'
                          : e.entry_type.replaceAll('_', ' ')}
                      </span>
                    </div>
                    <p className="opacity-50 text-[11px]">
                      {new Date(e.created_at).toLocaleDateString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {e.invoice_number ? ` · ${e.invoice_number}` : ''}
                      {e.notes ? ` · ${e.notes}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`font-semibold text-sm ${isEarn ? 'text-emerald-500' : 'text-amber-500'}`}>
                      {isEarn ? `+${e.amount_delta}` : e.amount_delta} {e.bucket === 'LOYALTY_POINTS' ? 'pts' : 'paise'}
                    </p>
                    <p className="text-[10px] opacity-40">
                      Balance: {e.balance_after} pts
                    </p>
                  </div>
                </div>
              );
            })}

          {!loyalty.isLoading &&
            (loyalty.data?.entries ?? []).filter((e) => {
              if (ledgerFilter === 'EARN') return e.amount_delta > 0;
              if (ledgerFilter === 'REDEEM') return e.amount_delta < 0;
              return true;
            }).length === 0 &&
            (loyalty.data?.entries?.length ?? 0) > 0 && (
              <p className="text-xs opacity-50 italic py-2 text-center">
                No loyalty transactions match the selected filter.
              </p>
            )}

          {!loyalty.isLoading && (!loyalty.data?.entries || loyalty.data.entries.length === 0) && (
            <p className="text-sm opacity-60 py-3 text-center">
              No loyalty transactions recorded yet. Complete visits at partner salons to start earning points!
            </p>
          )}
        </div>
      </section>

      <section className="card p-6 space-y-3">
        <h2 className="font-semibold">Saved addresses</h2>
        <div className="space-y-2">
          {(addresses.data?.addresses ?? []).map((a) => (
            <div key={a.id} className="flex items-start gap-3 border border-line rounded-2xl p-3 text-sm">
              <div className="flex-1">
                <b>{a.label}</b>
                {a.is_default && <span className="chip !py-0.5 !px-2 ml-2">default</span>}
                <p className="opacity-70">{a.address_line}</p>
                <p className="text-xs opacity-50">{a.locality}, {a.city} {a.postal_code}</p>
              </div>
              <button onClick={() => startEditAddress(a)} className="text-xs underline opacity-60">Edit</button>
              <button onClick={() => deleteAddress.mutate(a.id)} className="text-xs underline opacity-60">Remove</button>
            </div>
          ))}
          {!addresses.data?.addresses.length && <p className="text-sm opacity-60">No addresses yet.</p>}
        </div>
        <div className="grid sm:grid-cols-2 gap-3 pt-2">
          <input placeholder="Label" value={address.label} onChange={(e) => setAddress({ ...address, label: e.target.value })} className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          <input placeholder="Address line" value={address.address_line} onChange={(e) => setAddress({ ...address, address_line: e.target.value })} className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          <input placeholder="Locality" value={address.locality} onChange={(e) => setAddress({ ...address, locality: e.target.value })} className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          <input placeholder="City" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          <input placeholder="PIN code" value={address.postal_code} onChange={(e) => setAddress({ ...address, postal_code: e.target.value })} className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          <button onClick={saveAddress} disabled={!address.address_line || !address.locality} className="btn-primary !py-2 text-sm">
            {editingAddrId ? 'Save changes' : 'Add address'}
          </button>
          {editingAddrId && (
            <button onClick={() => { setEditingAddrId(null); setAddress({ ...address, address_line: '', locality: '', postal_code: '' }); }} className="text-xs underline opacity-60">
              Cancel edit
            </button>
          )}
        </div>
      </section>

      <section className="card p-6 space-y-3">
        <h2 className="font-semibold">Payments</h2>
        <div className="space-y-2">
          {(payments.data?.payments ?? []).slice(0, 10).map((p: any) => (
            <div key={p.id} className="flex items-center justify-between border-t border-line pt-2 text-sm">
              <span>{new Date(p.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })} · {p.provider}</span>
              <span>{rupees(Number(p.amount_paise))}</span>
              <span className="chip !py-0.5 !px-2">{p.status}</span>
            </div>
          ))}
          {!payments.data?.payments.length && <p className="text-sm opacity-60">No online payments yet.</p>}
        </div>
      </section>

      <section className="card p-6 space-y-3 border-red-200">
        <h2 className="font-semibold text-red-600">Delete account</h2>
        <p className="text-sm opacity-70">
          This will permanently erase your profile, addresses, preferences and consent records. Completed booking history
          is retained in anonymised form for salon records. This action cannot be undone.
        </p>
        <input
          value={deleteConfirm}
          onChange={(e) => setDeleteConfirm(e.target.value)}
          placeholder='Type "DELETE" to confirm'
          className="w-full border border-red-200 rounded-xl px-3 py-2 bg-transparent text-sm"
        />
        <button
          onClick={handleDeleteAccount}
          disabled={deleteConfirm !== 'DELETE' || deleteAccount.isPending}
          className="bg-red-600 text-white rounded-xl px-4 py-2 text-sm disabled:opacity-40"
        >
          {deleteAccount.isPending ? 'Deleting…' : 'Permanently delete my account'}
        </button>
      </section>
    </div>
  );
}
