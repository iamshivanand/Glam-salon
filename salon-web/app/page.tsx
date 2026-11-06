'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSalon, useSalonSearch } from '@/lib/api';
import { useBooking } from '@/lib/store';
import { salonImages, serviceImage, staffImage } from '@/lib/images';
import { rupees } from '@/lib/api';

const BADGE_LABEL: Record<string, string> = {
  PRIVATE_ROOM: 'Private rooms',
  WOMEN_ONLY_ZONE: "Women's zone",
  WHEELCHAIR_ACCESSIBLE: 'Step-free access',
  DISPOSABLE_KITS: 'Disposable kits',
  AUTOCLAVE_STERILIZED: 'Autoclave sterilised',
  PARKING: 'Parking',
};

function BookSalonButton({ salonId, children, className }: { salonId: string; children: React.ReactNode; className?: string }) {
  const router = useRouter();
  const setSalon = useBooking((s) => s.setSalon);
  return (
    <button
      onClick={() => {
        setSalon(salonId);
        router.push('/book');
      }}
      className={className ?? 'btn-accent !py-2 text-sm'}
    >
      {children}
    </button>
  );
}

export default function Home() {
  const { data: search, isLoading } = useSalonSearch({ lat: 12.9719, lng: 77.6412, radius_km: 15, sort: 'distance' });
  const salons = search?.salons ?? [];
  const primary = salons[0];
  const { data: profile } = useSalon(primary?.id);

  return (
    <div className="space-y-12 pt-8">
      <section className="card overflow-hidden grid md:grid-cols-2">
        <div className="p-8 md:p-12">
          <p className="text-accent font-semibold text-sm tracking-widest">
            {primary
              ? primary.review_count
                ? `★ ${primary.avg_rating.toFixed(1)} · ${primary.review_count} reviews`
                : '★ New salon'
              : '★ —'}{' '}
            · {primary?.locality ?? 'Bengaluru'}
          </p>
          <h1 className="font-display text-5xl md:text-6xl leading-tight mt-3">
            Beauty rituals,
            <br />
            booked in seconds.
          </h1>
          <p className="mt-4 opacity-70 max-w-md">
            Hair, skin, nails & spa by verified artists across Bengaluru. Transparent pricing, instant slots, loyalty rewards.
          </p>
          <div className="flex gap-3 mt-6">
            {primary ? (
              <BookSalonButton salonId={primary.id} className="btn-primary">
                Book at {primary.name.split(' ')[0]}
              </BookSalonButton>
            ) : (
              <Link href="/book" className="btn-primary">Book appointment</Link>
            )}
            <Link href="/services" className="chip !py-3 !px-6">Explore services</Link>
          </div>
          <div className="flex flex-wrap gap-4 mt-6 text-xs opacity-70">
            <span>✓ Verified hygiene</span>
            <span>✓ Instant confirmation</span>
            <span>✓ Live walk-in queue</span>
          </div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={salonImages[0]} alt="Glam Connect salon" className="h-72 md:h-full object-cover" />
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-3xl">Salons near you</h2>
          <span className="text-sm opacity-60">{isLoading ? 'Finding…' : `${search?.meta.total ?? 0} within 15 km`}</span>
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          {salons.map((s, i) => (
            <div key={s.id} className="card overflow-hidden flex flex-col">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={salonImages[i % salonImages.length]} alt={s.name} className="h-40 w-full object-cover" />
              <div className="p-5 flex-1 flex flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-lg leading-tight">{s.name}</p>
                    <p className="text-xs opacity-60">{s.locality} · {s.distance_km != null ? `${s.distance_km} km` : s.city}</p>
                  </div>
                  <span className="text-sm whitespace-nowrap">
                    {s.review_count ? `★ ${s.avg_rating.toFixed(1)} (${s.review_count})` : 'New'}
                  </span>
                </div>
                <p className="text-sm opacity-70 mt-2 line-clamp-2">{s.description}</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {s.hygiene_badges.slice(0, 3).map((b) => (
                    <span key={b} className="text-[10px] px-2 py-0.5 rounded-full border border-line">
                      {BADGE_LABEL[b] ?? b}
                    </span>
                  ))}
                </div>
                <div className="mt-auto pt-4 flex items-center justify-between">
                  <div className="text-xs opacity-60">
                    {s.live_queue.waiting_count > 0 ? `${s.live_queue.waiting_count} in walk-in queue` : 'No walk-in wait'}
                    <div>from {rupees(s.starting_price_paise)}</div>
                  </div>
                  <BookSalonButton salonId={s.id}>Book</BookSalonButton>
                </div>
              </div>
            </div>
          ))}
          {!isLoading && !salons.length && (
            <p className="opacity-60">No salons found. Is the API running on port 4000?</p>
          )}
        </div>
      </section>

      {profile && (
        <>
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-3xl">Popular at {profile.name}</h2>
              <Link href="/services" className="text-sm underline">View all</Link>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {profile.services.slice(0, 4).map((s) => (
                <Link key={s.id} href="/services" className="card overflow-hidden group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={serviceImage(s.category_slug)} alt={s.custom_name} className="h-40 w-full object-cover group-hover:scale-105 transition" />
                  <div className="p-4">
                    <p className="font-semibold">{s.custom_name}</p>
                    <p className="text-sm opacity-60">
                      {s.duration_mins} min · {rupees(s.discounted_price_paise ?? s.base_price_paise)}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </section>

          <section>
            <h2 className="font-display text-3xl mb-4">Top artists</h2>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {profile.staff.map((p, i) => (
                <div key={p.id} className="card p-4 min-w-[200px] text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={staffImage(i)} alt={p.display_name} className="w-20 h-20 rounded-full mx-auto object-cover" />
                  <p className="font-semibold mt-2">{p.display_name}</p>
                  <p className="text-xs opacity-60">
                    {p.specialization ?? 'Beauty artist'} · ★ {Number(p.avg_rating).toFixed(1)}
                  </p>
                  {p.is_bgv_verified && <p className="text-[10px] text-accent mt-1">✓ Background verified</p>}
                </div>
              ))}
            </div>
          </section>

          <section className="card p-8">
            <h2 className="font-display text-3xl mb-4">Loved by customers</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {profile.reviews.map((r) => (
                <div key={r.id} className="border border-line rounded-2xl p-4">
                  <p>{'★'.repeat(r.overall_rating)}<span className="opacity-30">{'★'.repeat(5 - r.overall_rating)}</span></p>
                  <p className="mt-1">“{r.review_text}”</p>
                  <p className="text-xs opacity-60 mt-2">
                    {r.customer_name} · {r.staff_name ?? 'Glam Connect'} · hygiene {r.hygiene_rating}/5
                  </p>
                </div>
              ))}
              {!profile.reviews.length && <p className="opacity-60">No reviews yet.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
