'use client';

import { useState } from 'react';
import { useCreateStaff, usePartnerStaff, useSetSchedule } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { staffImage } from '@/lib/images';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weeklySchedule() {
  return Array.from({ length: 7 }, (_, dow) => ({
    day_of_week: dow,
    shift_start: dow === 6 ? '09:00' : '10:00',
    shift_end: dow === 6 ? '21:00' : '20:00',
    breaks: dow === 0 ? [] : [{ start: '13:00', end: '14:00' }],
    is_working_day: dow !== 0,
  }));
}

export default function AdminStaff() {
  const { user } = useAuth();
  const { data, isLoading } = usePartnerStaff(!!user);
  const create = useCreateStaff();
  const schedule = useSetSchedule();

  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [years, setYears] = useState('3');
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const add = async () => {
    setProblem(null);
    try {
      if (!name.trim()) throw new Error('Name is required');
      await create.mutateAsync({
        display_name: name.trim(),
        specialization: spec || undefined,
        experience_years: Number(years) || 0,
      });
      setNotice(`Added ${name.trim()}`);
      setName('');
      setSpec('');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const applySchedule = async (staffId: string, staffName: string) => {
    setProblem(null);
    try {
      await schedule.mutateAsync({ staffId, entries: weeklySchedule() });
      setNotice(`Set Mon–Sat 10:00–20:00 for ${staffName}`);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-4xl">Staff</h1>
        <p className="text-sm opacity-60 mt-1">Artists, specialisations and weekly availability.</p>
      </div>

      {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">{notice}</div>}
      {problem && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{problem}</div>}

      <div className="card p-5">
        <p className="font-semibold mb-3">Add a team member</p>
        <div className="grid sm:grid-cols-4 gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="Specialisation" className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          <input value={years} onChange={(e) => setYears(e.target.value)} type="number" min="0" max="60" placeholder="Years" className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          <button onClick={add} disabled={create.isPending} className="btn-primary !py-2 text-sm">Add</button>
        </div>
      </div>

      {isLoading && <p>Loading team…</p>}

      <div className="grid sm:grid-cols-2 gap-4">
        {(data?.staff ?? []).map((p, i) => (
          <div key={p.id} className="card p-4 flex gap-3 items-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={staffImage(i)} className="w-14 h-14 rounded-full object-cover" alt={p.display_name} />
            <div className="flex-1">
              <p className="font-semibold">{p.display_name}</p>
              <p className="text-xs opacity-60">
                {p.specialization ?? 'Beauty artist'} · ★ {Number(p.avg_rating).toFixed(1)} ({p.review_count})
              </p>
              <p className="text-[11px] opacity-60 mt-1">
                Works {p.working_days.map((d) => DAYS[d]).join(', ') || '—'}
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => applySchedule(p.id, p.display_name)}
                  disabled={schedule.isPending}
                  className="text-[11px] border border-line rounded-full px-2 py-1 hover:border-accent"
                >
                  Set Mon–Sat 10–20
                </button>
                {p.is_bgv_verified && <span className="text-[10px] text-accent self-center">✓ BGV</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
