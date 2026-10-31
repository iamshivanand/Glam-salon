'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth, useAuthModal } from '@/lib/store';

const DEMO = [
  { label: 'Customer', phone: '+919800000002' },
  { label: 'Salon owner', phone: '+919800000001' },
];

export function AuthModal() {
  const { open, reason, closeModal } = useAuthModal();
  const { requestOtp, verifyOtp } = useAuth();
  const qc = useQueryClient();

  const [phone, setPhone] = useState('+919800000002');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devOtp, setDevOtp] = useState<string | undefined>();
  const [otp, setOtp] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setChallengeId(null);
      setOtp('');
      setDevOtp(undefined);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await requestOtp(phone);
      setChallengeId(res.challenge_id);
      setDevOtp(res.dev_otp);
      if (res.dev_otp) setOtp(res.dev_otp);
    } catch (err: any) {
      setError(err.message ?? 'Could not send the code');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(challengeId, otp, fullName || undefined);
      await qc.invalidateQueries();
      closeModal();
    } catch (err: any) {
      setError(err.message ?? 'That code did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4" onClick={closeModal}>
      <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-2xl">{challengeId ? 'Enter your code' : 'Sign in to Glam Connect'}</h2>
            <p className="text-sm opacity-60 mt-1">
              {reason ?? 'One code, no passwords. We only use your number to confirm bookings.'}
            </p>
          </div>
          <button onClick={closeModal} className="text-xl opacity-50 hover:opacity-100" aria-label="Close">×</button>
        </div>

        {!challengeId ? (
          <div className="mt-5 space-y-3">
            <label className="text-xs font-semibold uppercase tracking-wide opacity-60">Phone number</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+919800000002"
              className="w-full border border-line rounded-xl px-3 py-2.5 bg-transparent"
            />
            <div className="flex gap-2 text-xs">
              {DEMO.map((d) => (
                <button key={d.phone} onClick={() => setPhone(d.phone)} className="chip !py-1 !px-3">
                  {d.label}
                </button>
              ))}
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button onClick={send} disabled={busy} className="btn-primary w-full">
              {busy ? 'Sending…' : 'Send OTP'}
            </button>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <p className="text-sm opacity-70">Sent to {phone}</p>
            {devOtp && (
              <p className="text-xs rounded-xl bg-accent/15 border border-accent/40 px-3 py-2">
                Dev mode — your OTP is <b className="tracking-[0.3em]">{devOtp}</b>
              </p>
            )}
            <input
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6-digit code"
              inputMode="numeric"
              className="w-full border border-line rounded-xl px-3 py-2.5 bg-transparent tracking-[0.4em] text-center text-lg"
            />
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Your name (new customers only)"
              className="w-full border border-line rounded-xl px-3 py-2.5 bg-transparent text-sm"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button onClick={verify} disabled={busy || otp.length !== 6} className="btn-primary w-full">
              {busy ? 'Verifying…' : 'Verify & continue'}
            </button>
            <button onClick={() => setChallengeId(null)} className="text-xs underline opacity-60 w-full">
              Use a different number
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
