'use client';

import { useAuth, useAuthModal, isOwner } from '@/lib/store';

export function PartnerGate({ children }: { children: React.ReactNode }) {
  const { user, hydrated, logout } = useAuth();
  const { openModal } = useAuthModal();

  if (!hydrated) {
    return <div className="card p-8 mt-8">Checking your session…</div>;
  }

  if (!user) {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <p className="text-xs uppercase tracking-widest text-accent">Partner console</p>
        <h1 className="font-display text-3xl mt-2">Run your salon from one screen</h1>
        <p className="opacity-70 mt-2">
          Day book, POS billing, CRM, retention reminders and the live walk-in queue. Sign in with the owner phone number.
        </p>
        <button onClick={() => openModal('Sign in with your salon owner account.')} className="btn-primary mt-5">
          Sign in as salon owner
        </button>
        <p className="text-xs opacity-50 mt-4">Demo owner: +91 98000 00001</p>
      </div>
    );
  }

  if (!isOwner(user)) {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <h1 className="font-display text-3xl">This is the salon console</h1>
        <p className="opacity-70 mt-2">
          You are signed in as a customer. Sign in with an owner account to manage a salon.
        </p>
        <div className="flex gap-2 justify-center mt-5">
          <button
            onClick={() => {
              logout();
              openModal('Sign in with your salon owner account.');
            }}
            className="btn-primary"
          >
            Switch account
          </button>
          <a href="/appointments" className="chip !py-3">My visits</a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
