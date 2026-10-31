'use client';

import { useState } from 'react';
import { useCategories, useCreateService, usePartnerServices, useToggleService, rupees } from '@/lib/api';
import { useAuth } from '@/lib/store';

export default function AdminServices() {
  const { user } = useAuth();
  const { data, isLoading } = usePartnerServices(!!user);
  const { data: categories } = useCategories();
  const create = useCreateService();
  const toggle = useToggleService();

  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [price, setPrice] = useState('1200');
  const [duration, setDuration] = useState('60');
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const add = async () => {
    setProblem(null);
    try {
      if (!name.trim() || !categoryId) throw new Error('Name and category are required');
      await create.mutateAsync({
        category_id: categoryId,
        custom_name: name.trim(),
        base_price_paise: Math.round(Number(price) * 100),
        duration_mins: Number(duration),
      });
      setNotice(`Added ${name.trim()}`);
      setName('');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-4xl">Services</h1>
        <p className="text-sm opacity-60 mt-1">Live catalogue and pricing for your salon.</p>
      </div>

      {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">{notice}</div>}
      {problem && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{problem}</div>}

      <div className="card p-5">
        <p className="font-semibold mb-3">Add a service</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Service name" className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm lg:col-span-2" />
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm">
            <option value="">Category…</option>
            {(categories?.categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input value={price} onChange={(e) => setPrice(e.target.value)} type="number" min="0" placeholder="Price ₹" className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
          <div className="flex gap-2">
            <input value={duration} onChange={(e) => setDuration(e.target.value)} type="number" min="5" step="5" placeholder="Min" className="w-20 border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
            <button onClick={add} disabled={create.isPending} className="btn-primary !py-2 !px-4 text-sm flex-1">Add</button>
          </div>
        </div>
      </div>

      {isLoading && <p>Loading catalogue…</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="text-left opacity-60"><th className="p-3">Service</th><th>Category</th><th>Duration</th><th>Price</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {(data?.services ?? []).map((s) => (
              <tr key={s.id} className="border-t border-line">
                <td className="p-3 font-medium">{s.custom_name}</td>
                <td>{s.category_name}</td>
                <td>{s.duration_mins} min</td>
                <td>
                  {rupees(s.discounted_price_paise ?? s.base_price_paise)}
                  {s.discounted_price_paise && <span className="ml-2 text-xs line-through opacity-40">{rupees(s.base_price_paise)}</span>}
                </td>
                <td><span className="chip !py-0.5 !px-2">{s.is_active ? 'Active' : 'Hidden'}</span></td>
                <td className="pr-3 text-right">
                  <button
                    onClick={() => toggle.mutate({ id: s.id, is_active: !s.is_active })}
                    className="text-xs underline opacity-60 hover:opacity-100"
                  >
                    {s.is_active ? 'Hide' : 'Publish'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
