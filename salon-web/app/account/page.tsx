'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  rupees,
  uploadFile,
  useAddAddress,
  useAddresses,
  useConsentHistory,
  useConsents,
  useDeleteAccount,
  useDeleteAddress,
  useExportMyData,
  useMe,
  usePayments,
  useRevokeAllSessions,
  useRevokeSession,
  useSessions,
  useSetAvatar,
  useSetConsent,
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

export default function AccountPage() {
  const { user, hydrated, logout } = useAuth();
  const { openModal } = useAuthModal();
  const me = useMe(!!user);
  const updateMe = useUpdateMe();
  const consents = useConsents(!!user);
  const consentHistory = useConsentHistory(!!user);
  const setConsent = useSetConsent();
  const addresses = useAddresses(!!user);
  const addAddress = useAddAddress();
  const deleteAddress = useDeleteAddress();
  const setAvatar = useSetAvatar();
  const uploadStatus = useUploadStatus();
  const payments = usePayments(!!user);
  const sessions = useSessions(!!user);
  const revokeAllSessions = useRevokeAllSessions();
  const revokeSession = useRevokeSession();
  const exportData = useExportMyData();
  const deleteAccount = useDeleteAccount();

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
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

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
      await updateMe.mutateAsync({
        full_name: form.full_name,
        email: form.email || undefined,
        gender: form.gender || undefined,
        date_of_birth: form.date_of_birth || undefined,
      });
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
      await addAddress.mutateAsync({ ...address, is_default: !addresses.data?.addresses.length });
      setAddress({ ...address, address_line: '', locality: '', postal_code: '' });
      setNotice('Address saved.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const consentState = (purpose: string, channel: string): boolean => {
    const rows = consents.data?.consents ?? [];
    const specific = rows.find((c) => c.purpose === purpose && c.channel === channel && c.salon_id === null);
    return specific?.is_granted ?? purpose === 'RETENTION_REMINDER';
  };

  const signOutEverywhere = async () => {
    setNotice(null);
    setProblem(null);
    try {
      const result = await revokeAllSessions.mutateAsync();
      await logout();
      setNotice(`Signed out of ${result.revoked} session${result.revoked === 1 ? '' : 's'}.`);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const signOutDevice = async (id: string) => {
    setNotice(null);
    setProblem(null);
    try {
      await revokeSession.mutateAsync(id);
      setNotice('That device has been signed out.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const downloadData = async () => {
    setNotice(null);
    setProblem(null);
    try {
      const data = await exportData.mutateAsync();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `glam-connect-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice('Your data export has been downloaded.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const removeAccount = async () => {    setNotice(null);
    setProblem(null);
    if (deleteConfirm !== 'DELETE') {
      setProblem('Type DELETE to confirm account deletion.');
      return;
    }
    try {
      await deleteAccount.mutateAsync();
      await logout();
    } catch (err: any) {
      setProblem(err.message);
    }
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
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-xs opacity-60">
            Full name
            <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          </label>
          <label className="text-xs opacity-60">
            Email
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          </label>
          <label className="text-xs opacity-60">
            Gender
            <input value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          </label>
          <label className="text-xs opacity-60">
            Date of birth
            <input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          </label>
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

        <details className="pt-2">
          <summary className="text-xs cursor-pointer opacity-70">Consent history</summary>
          <ul className="mt-2 space-y-1 text-xs">
            {(consentHistory.data?.events ?? []).slice(0, 12).map((event) => (
              <li key={event.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-1">
                <span className="opacity-60">
                  {new Date(event.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                </span>
                <span>{event.purpose}</span>
                <span className="opacity-60">{event.channel}</span>
                <span className={event.is_granted ? 'text-green-700' : 'text-red-700'}>
                  {event.is_granted ? 'granted' : 'revoked'}
                </span>
              </li>
            ))}
            {!consentHistory.data?.events.length && <li className="opacity-60">No consent changes recorded yet.</li>}
          </ul>
        </details>
      </section>

      <section className="card p-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Sessions &amp; devices</h2>
          <div className="flex flex-wrap gap-2">
            <button onClick={downloadData} disabled={exportData.isPending} className="chip !py-1 !px-3 text-xs">
              {exportData.isPending ? 'Preparing…' : 'Download my data'}
            </button>
            <button onClick={signOutEverywhere} disabled={revokeAllSessions.isPending} className="chip !py-1 !px-3 text-xs">
              {revokeAllSessions.isPending ? 'Signing out…' : 'Sign out everywhere'}
            </button>
          </div>
        </div>
        <div className="space-y-2">
          {(sessions.data?.sessions ?? []).map((session) => (
            <div key={session.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-sm">
              <span>{session.device_fingerprint ? session.device_fingerprint.slice(0, 48) : 'Unknown device'}</span>
              <span className="text-xs opacity-60">{session.ip_address ?? 'no IP'}</span>
              <span className="text-xs opacity-60">
                started {new Date(session.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
              </span>
              <button
                onClick={() => signOutDevice(session.id)}
                disabled={revokeSession.isPending}
                className="text-xs underline opacity-60"
              >
                Sign out
              </button>
            </div>
          ))}
          {!sessions.data?.sessions.length && <p className="text-sm opacity-60">No active sessions.</p>}
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
            Add address
          </button>
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
        <h2 className="font-semibold text-red-700">Delete account</h2>
        <p className="text-xs opacity-60">
          This removes your profile details, addresses, push tokens and sessions. Past bookings and invoices are
          retained without your name for accounting and dispute handling. Upcoming bookings must be cancelled first.
        </p>
        {!showDelete ? (
          <button onClick={() => setShowDelete(true)} className="chip !py-2 text-xs text-red-700">
            Delete my account
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value.toUpperCase())}
              placeholder="Type DELETE"
              className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
            />
            <button
              onClick={removeAccount}
              disabled={deleteAccount.isPending || deleteConfirm !== 'DELETE'}
              className="chip !py-2 text-xs text-red-700 border-red-300 disabled:opacity-40"
            >
              {deleteAccount.isPending ? 'Deleting…' : 'Permanently delete'}
            </button>
            <button onClick={() => { setShowDelete(false); setDeleteConfirm(''); }} className="text-xs underline opacity-60">
              Cancel
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
