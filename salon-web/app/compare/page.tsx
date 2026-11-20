'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { rupees, useCategories, useCompareSalons, useSalonSearch } from '@/lib/api';
import { useBooking } from '@/lib/store';

export default function ComparePage() {
  const router = useRouter();
  const setBookingSalon = useBooking((s) => s.setSalon);

  const { data: catData } = useCategories();
  const categories = catData?.categories ?? [];

  const { data: searchData, isLoading: loadingSalons } = useSalonSearch({
    lat: 12.9719,
    lng: 77.6412,
    radius_km: 25,
  });
  const salons = searchData?.salons ?? [];

  const [selectedCatId, setSelectedCatId] = useState<string>('');
  const [selectedSalonIds, setSelectedSalonIds] = useState<string[]>([]);

  // Initialize with first category and first 2-3 salons once loaded
  useEffect(() => {
    if (!selectedCatId && categories.length > 0) {
      setSelectedCatId(categories[0].id);
    }
  }, [categories, selectedCatId]);

  useEffect(() => {
    if (selectedSalonIds.length === 0 && salons.length >= 2) {
      setSelectedSalonIds(salons.slice(0, 3).map((s) => s.id));
    }
  }, [salons, selectedSalonIds]);

  const toggleSalon = (id: string) => {
    if (selectedSalonIds.includes(id)) {
      if (selectedSalonIds.length > 2) {
        setSelectedSalonIds(selectedSalonIds.filter((x) => x !== id));
      }
    } else {
      if (selectedSalonIds.length < 4) {
        setSelectedSalonIds([...selectedSalonIds, id]);
      }
    }
  };

  const { data: compareData, isLoading: comparing } = useCompareSalons(
    selectedSalonIds,
    selectedCatId,
    selectedSalonIds.length >= 2 && !!selectedCatId,
  );

  const items = compareData?.comparison ?? [];

  const handleBook = (salonId: string) => {
    setBookingSalon(salonId);
    router.push('/book');
  };

  return (
    <div className="pt-8 space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="font-display text-4xl">Compare Salons</h1>
        <p className="text-sm opacity-60 mt-1">
          Side-by-side comparison of prices, verified hygiene facilities, and live queue times.
        </p>
      </div>

      {/* 1. Category Selector */}
      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-wide opacity-60">1. Select Service Category</label>
        <div className="flex gap-2 flex-wrap">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCatId(c.id)}
              className={`chip ${selectedCatId === c.id ? 'chip-active' : ''}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {/* 2. Salon Selector (2 to 4 salons) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase tracking-wide opacity-60">
            2. Choose 2 to 4 Salons to Compare ({selectedSalonIds.length}/4 selected)
          </label>
          <span className="text-xs opacity-50">Select between 2 and 4 salons</span>
        </div>
        <div className="flex gap-2 flex-wrap">
          {salons.map((s) => {
            const isSelected = selectedSalonIds.includes(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggleSalon(s.id)}
                className={`chip !py-1.5 !px-3 text-xs flex items-center gap-1.5 ${
                  isSelected ? 'chip-active' : ''
                }`}
              >
                <span>{isSelected ? '✓' : '+'}</span>
                <span>{s.name}</span>
                <span className="opacity-60 text-[10px]">({s.locality})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. Comparison Table */}
      {comparing && <p className="text-sm opacity-60">Loading comparison details…</p>}

      {!comparing && items.length >= 2 && (
        <div className="card overflow-x-auto p-6 space-y-4">
          <div className="min-w-[640px]">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left py-3 px-3 w-48 opacity-60 font-medium">Metric</th>
                  {items.map((item) => (
                    <th key={item.salon_id} className="text-left py-3 px-4 font-semibold text-base">
                      <div>{item.salon_name}</div>
                      <button
                        onClick={() => handleBook(item.salon_id)}
                        className="btn-accent !py-1 !px-3 text-xs font-normal mt-2 inline-block"
                      >
                        Book visit
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {/* Service Name */}
                <tr>
                  <td className="py-3 px-3 opacity-60 font-medium">Matched Service</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-3 px-4">
                      {item.service_name ?? <span className="opacity-40">Not offered</span>}
                    </td>
                  ))}
                </tr>

                {/* Price & Model */}
                <tr>
                  <td className="py-3 px-3 opacity-60 font-medium">Price</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-3 px-4">
                      {item.price_paise != null ? (
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{rupees(item.price_paise)}</span>
                          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border border-line opacity-75">
                            {item.pricing_model === 'STARTING_FROM_QUOTE' ? 'Starting quote' : 'Fixed'}
                          </span>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                  ))}
                </tr>

                {/* Duration */}
                <tr>
                  <td className="py-3 px-3 opacity-60 font-medium">Duration</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-3 px-4">
                      {item.duration_mins ? `${item.duration_mins} mins` : '—'}
                    </td>
                  ))}
                </tr>

                {/* Next Slot */}
                <tr>
                  <td className="py-3 px-3 opacity-60 font-medium">Next Slot</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-3 px-4">
                      {item.next_slot ? <span className="chip !py-0.5 !px-2 text-xs">{item.next_slot}</span> : 'No instant slot'}
                    </td>
                  ))}
                </tr>

                {/* Queue Wait */}
                <tr>
                  <td className="py-3 px-3 opacity-60 font-medium">Live Walk-in Wait</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-3 px-4">
                      {item.queue_wait_mins > 0 ? `${item.queue_wait_mins} mins (${item.queue_waiting_count ?? 1} waiting)` : 'No wait'}
                    </td>
                  ))}
                </tr>

                {/* Hygiene Header */}
                <tr className="bg-black/5 dark:bg-white/5">
                  <td colSpan={items.length + 1} className="py-2 px-3 text-xs font-semibold uppercase tracking-wider text-accent">
                    Verified Hygiene & Facilities
                  </td>
                </tr>

                {/* Private Rooms */}
                <tr>
                  <td className="py-2.5 px-3 opacity-60 font-medium">Private Rooms</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-2.5 px-4">
                      {item.facilities?.has_private_room ? <span className="text-green-600 font-bold">✓ Yes</span> : <span className="opacity-40">✕ No</span>}
                    </td>
                  ))}
                </tr>

                {/* Women's Zone */}
                <tr>
                  <td className="py-2.5 px-3 opacity-60 font-medium">Women-Only Zone</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-2.5 px-4">
                      {item.facilities?.has_women_only_zone ? <span className="text-green-600 font-bold">✓ Yes</span> : <span className="opacity-40">✕ No</span>}
                    </td>
                  ))}
                </tr>

                {/* Disposable Kits */}
                <tr>
                  <td className="py-2.5 px-3 opacity-60 font-medium">Disposable Kits</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-2.5 px-4">
                      {item.facilities?.uses_disposable_kits ? <span className="text-green-600 font-bold">✓ Yes</span> : <span className="opacity-40">✕ No</span>}
                    </td>
                  ))}
                </tr>

                {/* Autoclave Sterilization */}
                <tr>
                  <td className="py-2.5 px-3 opacity-60 font-medium">Autoclave Sterilization</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-2.5 px-4">
                      {item.facilities?.autoclave_sterilization ? <span className="text-green-600 font-bold">✓ Yes</span> : <span className="opacity-40">✕ No</span>}
                    </td>
                  ))}
                </tr>

                {/* Wheelchair Accessible */}
                <tr>
                  <td className="py-2.5 px-3 opacity-60 font-medium">Step-Free Access</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-2.5 px-4">
                      {item.facilities?.wheelchair_accessible ? <span className="text-green-600 font-bold">✓ Yes</span> : <span className="opacity-40">✕ No</span>}
                    </td>
                  ))}
                </tr>

                {/* Verified by Admin */}
                <tr>
                  <td className="py-2.5 px-3 opacity-60 font-medium">Verification Status</td>
                  {items.map((item) => (
                    <td key={item.salon_id} className="py-2.5 px-4 text-xs">
                      {item.facilities?.verified_by_admin_name ? (
                        <div className="text-accent font-medium flex items-center gap-1">
                          <span>🛡️ Verified by {item.facilities.verified_by_admin_name}</span>
                        </div>
                      ) : (
                        <span className="opacity-50">Standard listing</span>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!comparing && items.length < 2 && (
        <div className="card p-8 text-center opacity-60">
          Select at least 2 salons above to generate the comparison matrix.
        </div>
      )}
    </div>
  );
}
