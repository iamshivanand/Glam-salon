'use client';

import { useState } from 'react';
import { useCreateResource, usePartnerResources } from '@/lib/api';
import { useAuth } from '@/lib/store';

const TYPES = ['SPA_ROOM', 'MAKEUP_STATION', 'CHAIR', 'WASH_STATION', 'OTHER'];

export default function AdminResources() {
  const { user } = useAuth();
  const { data, isLoading } = usePartnerResources(!!user);
  const create = useCreateResource();

  const [name, setName] = useState('');
  const [type, setType] = useState(TYPES[0]);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const add = async () => {
    setNotice(null);
    setProblem(null);
    try {
      if (!name.trim()) throw new Error('Name is required');
      await create.mutateAsync({ name: name.trim(), resource_type: type });
      setNotice(`Added ${name.trim()}`);
      setName('');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-4xl">Resources</h1>
        <p className="text-sm opacity-60 mt-1">Rooms, chairs and stations that bookable services depend on.</p>
      </div>

      {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">{notice}</div>}
      {problem && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{problem}</div>}

      <div className="card p-5">
        <p className="font-semibold mb-3">Add a resource</p>
        <div className="flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Spa Room 3"
            className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm flex-1 min-w-[180px]"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
          >
            {TYPES.map((t) => <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>)}
          </select>
          <button onClick={add} disabled={create.isPending} className="btn-primary !py-2 !px-4 text-sm">Add</button>
        </div>
      </div>

      {isLoading && <p>Loading resources…</p>}

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(data?.resources ?? []).map((r) => (
          <div key={r.id} className="card p-5">
            <p className="font-semibold">{r.name}</p>
            <p className="text-xs opacity-60 mt-1">{r.resource_type.replaceAll('_', ' ')}</p>
          </div>
        ))}
        {!isLoading && !data?.resources.length && <p className="text-sm opacity-60">No resources configured.</p>}
      </div>
    </div>
  );
}
