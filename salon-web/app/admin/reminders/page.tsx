'use client';

import { useState } from 'react';
import { useDispatchReminders, usePartnerCrm, usePartnerReminders, useTriggerReminders } from '@/lib/api';
import { useAuth } from '@/lib/store';

const CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL', 'PUSH'] as const;

export default function AdminReminders() {
  const { user } = useAuth();
  const { data, isLoading } = usePartnerReminders(!!user);
  const { data: crm } = usePartnerCrm(!!user);
  const trigger = useTriggerReminders();
  const dispatch = useDispatchReminders();

  const [selected, setSelected] = useState<string[]>([]);
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('WHATSAPP');
  const [template, setTemplate] = useState('DAY_25_INVITE');
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const send = async () => {
    setNotice(null);
    setProblem(null);
    try {
      if (!selected.length) throw new Error('Select at least one customer');
      const res = await trigger.mutateAsync({ customer_ids: selected, channel, template_code: template });
      setNotice(
        `Queued ${res.enqueued} · sent ${res.sent}${res.failed ? ` · failed ${res.failed} (will retry)` : ''}` +
          `${res.skipped ? ` · skipped ${res.skipped} (no consent or opt-out)` : ''}`,
      );
      setSelected([]);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const runDispatch = async () => {
    setNotice(null);
    setProblem(null);
    try {
      const res = await dispatch.mutateAsync({ limit: 50 });
      setNotice(
        `Due ${res.due} · sent ${res.sent} · suppressed ${res.suppressed} · failed ${res.failed} · locked ${res.skipped}`,
      );
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const summary = data?.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl">Retention</h1>
          <p className="text-sm opacity-60 mt-1">
            Reminder journey with provider delivery and retries. Development falls back to the console
            provider until SMS/WhatsApp credentials are configured.
          </p>
        </div>
        <button onClick={runDispatch} disabled={dispatch.isPending} className="chip !py-2">
          {dispatch.isPending ? 'Running…' : 'Run due reminders'}
        </button>
      </div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          ['Sent', summary?.sent],
          ['Delivered', summary?.delivered],
          ['Clicked', summary?.clicked],
          ['Converted', summary?.converted_bookings],
        ].map(([label, value]) => (
          <div key={String(label)} className="card p-5">
            <p className="text-xs opacity-60">{label}</p>
            <p className="font-display text-3xl mt-1">{value ?? 0}</p>
          </div>
        ))}
      </div>

      <div className="card p-5 space-y-3">
        <p className="font-semibold">Send a reminder now</p>
        {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">{notice}</div>}
        {problem && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{problem}</div>}

        <div className="flex flex-wrap gap-2">
          {(crm?.customers ?? []).map((c) => (
            <label key={c.customer_id} className="chip !py-2 flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(c.customer_id)}
                onChange={() => toggle(c.customer_id)}
              />
              {c.customer_name}
            </label>
          ))}
          {!crm?.customers.length && <p className="text-sm opacity-60">No customers in CRM yet.</p>}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs opacity-60">
            Channel
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as (typeof CHANNELS)[number])}
              className="block mt-1 border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
            >
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-xs opacity-60">
            Template
            <input
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="block mt-1 border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
            />
          </label>
          <button onClick={send} disabled={trigger.isPending} className="btn-primary !py-2 !px-4 text-sm">
            {trigger.isPending ? 'Sending…' : 'Send reminder'}
          </button>
        </div>
        <p className="text-[11px] opacity-50">
          Only customers with a granted RETENTION_REMINDER consent for the chosen channel are sent.
          Failed deliveries stay queued and retry with backoff. PUSH needs a webhook or device service.
        </p>
      </div>

      {isLoading && <p>Loading reminders…</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="text-left opacity-60">
              <th className="p-3">Customer</th>
              <th>Stage</th>
              <th>Channel</th>
              <th>Template</th>
              <th>Scheduled</th>
              <th>Status</th>
              <th>Delivery</th>
            </tr>
          </thead>
          <tbody>
            {(data?.reminders ?? []).map((r: any) => (
              <tr key={r.id} className="border-t border-line">
                <td className="p-3 font-medium">{r.customer_name}</td>
                <td>{r.stage}</td>
                <td>{r.channel}</td>
                <td className="text-xs opacity-70">{r.template_code}</td>
                <td>{new Date(r.scheduled_for).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                <td><span className="chip !py-0.5 !px-2">{r.status}</span></td>
                <td className="text-[11px] max-w-[220px] truncate">
                  {r.last_error ? (
                    <span className="text-red-700">{r.last_error}</span>
                  ) : r.provider_message_id ? (
                    <span className="opacity-70">{r.provider_message_id}</span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && !data?.reminders.length && <p className="p-6 text-sm opacity-60">No reminders queued.</p>}
      </div>
    </div>
  );
}
