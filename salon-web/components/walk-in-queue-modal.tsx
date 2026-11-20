'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  API_URL,
  rupees,
  useJoinQueue,
  useLeaveQueue,
  useLiveQueue,
  useQueueToken,
  useSalon,
} from '@/lib/api';
import { useAuth } from '@/lib/store';

export interface WalkInQueueModalProps {
  salon: {
    id: string;
    name: string;
    locality?: string;
  } | null;
  onClose: () => void;
}

export function WalkInQueueModal({ salon, onClose }: WalkInQueueModalProps) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [activeTokenId, setActiveTokenId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [preferredStaffId, setPreferredStaffId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Initialize customer info and active token from localStorage
  useEffect(() => {
    if (!salon?.id) return;
    const stored = typeof window !== 'undefined' ? localStorage.getItem(`glam_queue_${salon.id}`) : null;
    if (stored) {
      setActiveTokenId(stored);
    }
    if (user?.full_name) {
      setCustomerName(user.full_name);
    }
    if (user?.phone) {
      setPhone(user.phone);
    }
  }, [salon?.id, user]);

  const { data: salonData } = useSalon(salon?.id);
  const { data: liveData } = useLiveQueue(salon?.id ?? '', !!salon?.id);
  const { data: tokenData } = useQueueToken(salon?.id ?? '', activeTokenId, !!salon?.id && !!activeTokenId);

  // Auto-clear stored token if it reached terminal state
  useEffect(() => {
    if (tokenData && ['COMPLETED', 'SKIPPED', 'LEFT_QUEUE'].includes(tokenData.status)) {
      if (typeof window !== 'undefined' && salon?.id) {
        localStorage.removeItem(`glam_queue_${salon.id}`);
      }
    }
  }, [tokenData, salon?.id]);

  // Real-time SSE listener
  useEffect(() => {
    if (!salon?.id) return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`${API_URL}/queue/${salon.id}/live?stream=true`);
      es.onmessage = (event) => {
        try {
          const snapshot = JSON.parse(event.data);
          qc.setQueryData(['queue', 'live', salon.id], snapshot);
          if (activeTokenId) {
            qc.invalidateQueries({ queryKey: ['queue', 'token', salon.id, activeTokenId] });
          }
        } catch {
          // ignore parse errors
        }
      };
    } catch {
      // EventSource not supported or blocked, polling fallback handles it
    }

    return () => {
      es?.close();
    };
  }, [salon?.id, activeTokenId, qc]);

  const joinMutation = useJoinQueue();
  const leaveMutation = useLeaveQueue();

  if (!salon) return null;

  const handleToggleService = (serviceId: string) => {
    setSelectedServiceIds((prev) =>
      prev.includes(serviceId) ? prev.filter((id) => id !== serviceId) : [...prev, serviceId],
    );
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName.trim()) {
      setError('Please provide your name');
      return;
    }
    if (!selectedServiceIds.length) {
      setError('Please select at least one service');
      return;
    }

    setError(null);
    try {
      const res = await joinMutation.mutateAsync({
        salon_id: salon.id,
        customer_name: customerName.trim(),
        phone: phone.trim() || undefined,
        service_ids: selectedServiceIds,
        preferred_staff_id: preferredStaffId || undefined,
      });

      setActiveTokenId(res.token_id);
      if (typeof window !== 'undefined') {
        localStorage.setItem(`glam_queue_${salon.id}`, res.token_id);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to join queue. Remote walk-ins may be paused.');
    }
  };

  const handleLeave = async () => {
    if (!activeTokenId) return;
    try {
      await leaveMutation.mutateAsync({ salonId: salon.id, tokenId: activeTokenId });
      setActiveTokenId(null);
      if (typeof window !== 'undefined') {
        localStorage.removeItem(`glam_queue_${salon.id}`);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to leave queue');
    }
  };

  const isTerminal = tokenData && ['COMPLETED', 'SKIPPED', 'LEFT_QUEUE'].includes(tokenData.status);
  const showTracker = !!activeTokenId && !!tokenData && !isTerminal;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface border border-line rounded-3xl p-6 sm:p-8 max-w-lg w-full shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-xl opacity-60 hover:opacity-100 transition"
          aria-label="Close"
        >
          &times;
        </button>

        <div className="mb-6">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-semibold tracking-wider uppercase text-accent">Digital Walk-In Queue</span>
          </div>
          <h2 className="font-display text-2xl font-bold mt-1">{salon.name}</h2>
          {salon.locality && <p className="text-xs opacity-60">{salon.locality}</p>}
        </div>

        {/* Salon Live Queue Overview */}
        <div className="grid grid-cols-2 gap-3 mb-6 p-4 rounded-2xl bg-surface-raised border border-line text-center">
          <div>
            <p className="text-[11px] opacity-60 uppercase font-medium">Now Serving</p>
            <p className="text-2xl font-display font-semibold mt-0.5">
              {liveData?.now_serving_token ? `#${liveData.now_serving_token}` : '—'}
            </p>
          </div>
          <div>
            <p className="text-[11px] opacity-60 uppercase font-medium">Waiting</p>
            <p className="text-2xl font-display font-semibold mt-0.5">
              {liveData?.waiting_count ?? 0} {liveData?.waiting_count === 1 ? 'person' : 'people'}
            </p>
          </div>
        </div>

        {liveData?.walkin_paused && !showTracker && (
          <div className="mb-5 p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs leading-relaxed">
            <p className="font-semibold">Remote walk-ins paused</p>
            <p className="mt-0.5 opacity-90">
              This salon is currently not accepting remote queue joins. In-person counter walk-ins may still be available.
            </p>
          </div>
        )}

        {/* View 1: Active Token Tracker */}
        {showTracker ? (
          <div className="space-y-5">
            <div className="text-center p-6 rounded-3xl bg-accent/10 border border-accent/30 relative overflow-hidden">
              <span className="text-xs font-semibold uppercase tracking-widest text-accent">Your Token</span>
              <p className="text-5xl font-display font-bold mt-2 text-foreground">
                #{tokenData.token_number}
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                {tokenData.status === 'CALLED' ? (
                  <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 animate-pulse">
                    🔔 You&apos;re next! Please head to counter
                  </span>
                ) : tokenData.status === 'IN_SERVICE' ? (
                  <span className="px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-600 dark:text-blue-400 border border-blue-500/30">
                    ✂️ Currently in service
                  </span>
                ) : (
                  <span className="px-3 py-1 rounded-full text-xs font-semibold bg-accent/20 text-accent border border-accent/30">
                    Waiting in queue
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="card p-3 border border-line rounded-2xl">
                <p className="text-xs opacity-60">People Ahead</p>
                <p className="text-xl font-bold mt-0.5">{tokenData.people_ahead}</p>
              </div>
              <div className="card p-3 border border-line rounded-2xl">
                <p className="text-xs opacity-60">Est. Wait Time</p>
                <p className="text-xl font-bold mt-0.5">
                  {tokenData.status === 'IN_SERVICE' ? '0 mins' : `~${tokenData.estimated_wait_mins} mins`}
                </p>
              </div>
            </div>

            <p className="text-[11px] text-center opacity-60 leading-normal">
              Live updates enabled via real-time stream. You will also receive an SMS/push notification when your token is called.
            </p>

            <button
              onClick={handleLeave}
              disabled={leaveMutation.isPending}
              className="w-full py-2.5 rounded-full border border-line text-xs font-medium opacity-70 hover:opacity-100 hover:border-red-500/50 hover:text-red-600 transition"
            >
              {leaveMutation.isPending ? 'Leaving…' : 'Leave Queue'}
            </button>
          </div>
        ) : (
          /* View 2: Join Form */
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium opacity-70 mb-1">Your Name *</label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Full name"
                className="w-full border border-line rounded-xl px-3.5 py-2.5 bg-transparent text-sm"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium opacity-70 mb-1">Phone Number (for SMS token updates)</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
                className="w-full border border-line rounded-xl px-3.5 py-2.5 bg-transparent text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium opacity-70 mb-1.5">Select Services *</label>
              <div className="max-h-44 overflow-y-auto space-y-1.5 pr-1 border border-line rounded-2xl p-2.5">
                {(salonData?.services ?? []).map((s) => {
                  const selected = selectedServiceIds.includes(s.id);
                  const price = s.discounted_price_paise ?? s.base_price_paise;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleToggleService(s.id)}
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left text-xs transition border ${
                        selected
                          ? 'bg-accent/15 border-accent text-foreground font-medium'
                          : 'border-transparent hover:bg-surface-raised opacity-80'
                      }`}
                    >
                      <span className="truncate pr-2">{s.custom_name}</span>
                      <span className="whitespace-nowrap opacity-75">
                        {s.duration_mins}m · {rupees(price)}
                      </span>
                    </button>
                  );
                })}
                {!salonData?.services?.length && (
                  <p className="text-xs opacity-50 py-3 text-center">Loading services…</p>
                )}
              </div>
            </div>

            {salonData?.staff && salonData.staff.length > 0 && (
              <div>
                <label className="block text-xs font-medium opacity-70 mb-1">Preferred Stylist (Optional)</label>
                <select
                  value={preferredStaffId}
                  onChange={(e) => setPreferredStaffId(e.target.value)}
                  className="w-full border border-line rounded-xl px-3.5 py-2 bg-transparent text-xs"
                >
                  <option value="">Any qualified stylist (Fastest)</option>
                  {salonData.staff.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.display_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={joinMutation.isPending || liveData?.walkin_paused || !selectedServiceIds.length}
              className="btn-accent w-full !py-3 rounded-full text-sm font-semibold disabled:opacity-50 transition"
            >
              {joinMutation.isPending
                ? 'Joining Queue…'
                : liveData?.walkin_paused
                ? 'Walk-ins Paused'
                : 'Join Digital Queue'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
