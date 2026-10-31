'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useCategories, useSalon, useSalonSearch, rupees } from '@/lib/api';
import { useBooking } from '@/lib/store';
import { serviceImage } from '@/lib/images';

export default function ServicesPage() {
  const { data: search, isLoading: loadingSalons } = useSalonSearch({ lat: 12.9719, lng: 77.6412, radius_km: 15 });
  const salons = search?.salons ?? [];
  const { salonId, setSalon, toggleService, serviceIds } = useBooking();
  const activeSalonId = salonId ?? salons[0]?.id;
  const { data: profile, isLoading } = useSalon(activeSalonId);
  const { data: categories } = useCategories();
  const [cat, setCat] = useState('all');

  const grouped = useMemo(() => {
    if (!profile) return [];
    const bySlug = new Map<string, { name: string; slug: string; items: typeof profile.services }>();
    for (const s of profile.services) {
      const entry = bySlug.get(s.category_slug) ?? { name: s.category_name, slug: s.category_slug, items: [] };
      entry.items.push(s);
      bySlug.set(s.category_slug, entry);
    }
    return Array.from(bySlug.values());
  }, [profile]);

  const visible = cat === 'all' ? grouped : grouped.filter((g) => g.slug === cat);

  return (
    <div className="pt-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl">Services & pricing</h1>
          <p className="text-sm opacity-60 mt-1">Live catalogue from verified salons. Prices include all taxes at checkout.</p>
        </div>
        {salons.length > 0 && (
          <select
            value={activeSalonId}
            onChange={(e) => setSalon(e.target.value)}
            className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm max-w-xs"
          >
            {salons.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.locality}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setCat('all')} className={`chip ${cat === 'all' ? 'chip-active' : ''}`}>All</button>
        {(categories?.categories ?? []).map((c) => (
          <button key={c.id} onClick={() => setCat(c.slug)} className={`chip ${cat === c.slug ? 'chip-active' : ''}`}>{c.name}</button>
        ))}
      </div>

      {(isLoading || loadingSalons) && <p>Loading services…</p>}

      {visible.map((group) => (
        <section key={group.slug}>
          <h2 className="font-display text-2xl mb-3">{group.name}</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {group.items.map((s) => {
              const price = s.discounted_price_paise ?? s.base_price_paise;
              const added = serviceIds.includes(s.id);
              return (
                <div key={s.id} className="card overflow-hidden flex flex-col">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={serviceImage(s.category_slug)} alt={s.custom_name} className="h-44 w-full object-cover" />
                  <div className="p-5 flex-1 flex flex-col">
                    <p className="font-semibold text-lg">{s.custom_name}</p>
                    <p className="text-sm opacity-60">{s.description}</p>
                    <p className="mt-2 text-sm">
                      {s.duration_mins} min · <b>{rupees(price)}</b>
                      {s.discounted_price_paise && <span className="ml-2 line-through opacity-40">{rupees(s.base_price_paise)}</span>}
                    </p>
                    {s.available_for_home_visit && <p className="text-[11px] text-accent mt-1">Available at home</p>}
                    <div className="flex gap-2 mt-auto pt-4">
                      <button onClick={() => toggleService(s.id)} className={`chip ${added ? 'chip-active' : ''}`}>
                        {added ? 'Added ✓' : 'Add'}
                      </button>
                      <Link href="/book" className="btn-accent !py-2 text-sm">Book</Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {serviceIds.length > 0 && (
        <div className="sticky bottom-4 card p-4 flex items-center justify-between gap-3">
          <p className="text-sm">{serviceIds.length} service(s) selected</p>
          <Link href="/book" className="btn-primary !py-2">Continue to booking</Link>
        </div>
      )}
    </div>
  );
}
