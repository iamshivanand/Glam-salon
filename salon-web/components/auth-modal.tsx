'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth, useAuthModal } from '@/lib/store';

declare global {
  interface Window {
    google?: any;
  }
}

const DEMO = [
  { label: 'Customer', phone: '+919800000002' },
  { label: 'Salon owner', phone: '+919800000001' },
];

export function AuthModal() {
  const { open, reason, closeModal } = useAuthModal();
  const { requestOtp, verifyOtp, loginWithOAuth } = useAuth();
  const qc = useQueryClient();

  const [phone, setPhone] = useState('+919800000002');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devOtp, setDevOtp] = useState<string | undefined>();
  const [otp, setOtp] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);

  const googleBtnRef = useRef<HTMLDivElement>(null);
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  // Load Google Identity Services SDK
  useEffect(() => {
    if (typeof window === 'undefined' || !googleClientId) return;

    const initGsi = () => {
      if (window.google?.accounts?.id) {
        try {
          window.google.accounts.id.initialize({
            client_id: googleClientId,
            callback: async (response: any) => {
              if (!response?.credential) return;
              setBusy(true);
              setError(null);
              try {
                await loginWithOAuth('google', response.credential);
                await qc.invalidateQueries();
                closeModal();
              } catch (err: any) {
                setError(err.message ?? 'Google sign-in failed');
              } finally {
                setBusy(false);
              }
            },
          });
          setGoogleReady(true);
        } catch {
          // ignore GSI init issues
        }
      }
    };

    if (window.google?.accounts?.id) {
      initGsi();
    } else {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = initGsi;
      document.head.appendChild(script);
    }
  }, [googleClientId, loginWithOAuth, qc, closeModal]);

  // Render Google button when modal opens and GSI is ready
  useEffect(() => {
    if (open && googleReady && googleBtnRef.current && window.google?.accounts?.id) {
      try {
        googleBtnRef.current.innerHTML = '';
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          width: 380,
        });
      } catch {
        // fallback to custom button if render fails
      }
    }
  }, [open, googleReady]);

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

  const handleGoogleClick = () => {
    if (!googleClientId) {
      setError('Google Sign-In is not configured yet');
      return;
    }
    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.prompt();
      } catch (e: any) {
        setError(e.message ?? 'Could not open Google Sign-In');
      }
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
            <div className="relative flex items-center gap-3 pt-1">
              <div className="flex-1 border-t border-line" />
              <span className="text-xs opacity-40">or</span>
              <div className="flex-1 border-t border-line" />
            </div>

            {/* Google One-Tap / GSI Container */}
            <div className="w-full flex flex-col items-center">
              <div ref={googleBtnRef} className="w-full flex justify-center min-h-[44px]" />
              {!googleReady && (
                <button
                  onClick={handleGoogleClick}
                  disabled={busy}
                  className="w-full border border-line rounded-full px-4 py-2.5 text-sm flex items-center justify-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 transition"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09A6.74 6.74 0 0 1 5.5 12c0-.72.13-1.43.35-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.77.42 3.44 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  <span>Continue with Google</span>
                </button>
              )}
            </div>

            <button disabled className="w-full border border-line rounded-full px-4 py-2.5 text-sm opacity-50 flex items-center justify-center gap-2 cursor-not-allowed">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.5.12 2.65.71 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
              <span>Sign in with Apple <span className="text-[10px] opacity-70">(coming soon)</span></span>
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
