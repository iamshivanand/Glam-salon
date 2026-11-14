'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PartnerGate } from '@/components/partner-gate';
import { getActiveSalonId, setActiveSalonId, usePartnerSalons } from '@/lib/api';
import { useAuth } from '@/lib/store';

const NAV: [string, string][] = [
  ['Overview', '/admin'],
  ['Calendar', '/admin/calendar'],
  ['Bookings', '/admin/bookings'],
  ['Customers', '/admin/crm'],
  ['Reviews', '/admin/reviews'],
  ['Retention', '/admin/reminders'],
  ['Invoices', '/admin/invoices'],
  ['Settlements', '/admin/settlements'],
  ['Staff', '/admin/staff'],
  ['Services', '/admin/services'],
  ['Resources', '/admin/resources'],
];

function SalonSwitcher() {
  const { data } = usePartnerSalons();
  const qc = useQueryClient();
  const [active, setActive] = useState<string | null>(null);
  const salons = data?.salons ?? [];

  const choose = (salonId: string) => {
    setActiveSalonId(salonId);
    setActive(salonId);
    // Query keys are salon-agnostic; refetch everything now that X-Salon-Id changed.
    void qc.invalidateQueries();
  };

  useEffect(() => {
    const stored = getActiveSalonId();
    const next =
      stored && salons.some((s) => s.id === stored) ? stored : data?.active_salon_id ?? salons[0]?.id ?? null;
    setActive(next);
    if (next) setActiveSalonId(next);
  }, [data?.active_salon_id, salons]);

  useEffect(() => {
    const onChange = (event: Event) => setActive((event as CustomEvent<string | null>).detail ?? null);
    window.addEventListener('gc:salon-changed', onChange);
    return () => window.removeEventListener('gc:salon-changed', onChange);
  }, []);

  if (salons.length <= 1) {
    return (
      <div className="px-1 pb-3 text-[11px] uppercase tracking-widest opacity-50">
        {salons[0]?.name ?? 'Your salon'}
      </div>
    );
  }

  return (
    <label className="block pb-3 text-xs opacity-70">
      Active salon
      <select
        value={active ?? ''}
        onChange={(event) => {
          choose(event.target.value);
        }}
        className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
      >
        {salons.map((salon) => (
          <option key={salon.id} value={salon.id}>
            {salon.name} · {salon.locality}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === 'PLATFORM_ADMIN';
  const canOnboard = user?.role === 'SALON_OWNER';

  return (
    <PartnerGate>
      <div className="pt-8 grid lg:grid-cols-[220px_1fr] gap-6">
        <aside className="card p-4 h-fit lg:sticky lg:top-20 flex lg:flex-col gap-2 overflow-x-auto">
          <SalonSwitcher />
          {NAV.map(([t, h]) => (
            <Link key={h} href={h} className="chip whitespace-nowrap">
              {t}
            </Link>
          ))}
          {canOnboard && (
            <Link href="/onboarding" className="chip whitespace-nowrap border-accent/40">
              Onboarding & KYC
            </Link>
          )}
          {isPlatformAdmin && (
            <Link href="/platform" className="chip whitespace-nowrap border-accent/40">
              Platform admin
            </Link>
          )}
          <div className="hidden lg:block mt-4 pt-4 border-t border-line text-[11px] opacity-50 leading-relaxed">
            Glam Connect partner console.
            <br />
            Local dev uses the console notification provider until credentials are configured.
          </div>
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </PartnerGate>
  );
}
