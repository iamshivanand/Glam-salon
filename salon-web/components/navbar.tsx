'use client';

import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';
import { useAuth, useAuthModal, isOwner } from '@/lib/store';

function AuthButton() {
  const { user, hydrated, logout } = useAuth();
  const { openModal } = useAuthModal();

  if (!hydrated) return <div className="w-20 h-8" />;

  if (!user) {
    return (
      <button onClick={() => openModal()} className="chip !py-2">
        Sign in
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="hidden sm:inline text-sm">
        {user.full_name.split(' ')[0]}
        {isOwner(user) && <span className="ml-1 text-[10px] uppercase tracking-wide text-accent">owner</span>}
      </span>
      <button onClick={logout} className="text-xs underline opacity-60 hover:opacity-100">
        Sign out
      </button>
    </div>
  );
}

export function Navbar() {
  const { user } = useAuth();
  return (
    <header className="sticky top-0 z-40 backdrop-blur bg-background/80 border-b border-line dark:border-white/10">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center gap-6">
        <Link href="/" className="font-display text-2xl font-semibold">
          Glam Connect <span className="text-accent">✦</span>
        </Link>
        <nav className="hidden md:flex gap-5 text-sm">
          <Link href="/services">Services</Link>
          <Link href="/book">Book</Link>
          <Link href="/appointments">My visits</Link>
          <Link href="/admin" className="font-semibold">For salons</Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {user && isOwner(user) && (
            <Link href="/admin" className="hidden sm:inline chip !py-2">
              Dashboard
            </Link>
          )}
          <AuthButton />
          <ThemeToggle />
          <Link href="/book" className="btn-accent !py-2">Book now</Link>
        </div>
      </div>
    </header>
  );
}
