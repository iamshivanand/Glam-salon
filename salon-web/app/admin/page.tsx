'use client';

import { usePartnerBookings, usePartnerDashboard, usePartnerQueue, usePartnerReminders, rupees } from '@/lib/api';
import { StaffBar } from '@/components/charts';
import { useAuth } from '@/lib/store';

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export default function AdminOverview() {
  const { user } = useAuth();
  const today = todayIST();
  const { data: s, isLoading } = usePartnerDashboard('MONTH', !!user);
  const { data: day } = usePartnerBookings(today, !!user);
  const { data: reminders } = usePartnerReminders(!!user);
  const { data: queue } = usePartnerQueue(!!user);

  if (isLoading || !s) return <p>Loading analytics…</p>;

  const kpis = [
    ['Revenue · 30 days', rupees(s.revenue_paise), `${s.completed_visits} completed visits`],
    ['Average bill', rupees(s.avg_bill_paise), `${s.completed_services} services delivered`],
    ['Retention', `${s.retention_rate_pct}%`, `${s.returning_customers} returning · ${s.new_customers} new`],
    ['Reminder conversion', `${s.reminder_conversion_rate_pct}%`, `${reminders?.summary.sent ?? 0} messages sent`],
  ];

  const todays = day?.bookings ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-4xl">Salon overview</h1>
          <p className="text-sm opacity-60 mt-1">Live data for {today} (IST)</p>
        </div>
        <span className="chip !py-1 !px-3">{user?.full_name}</span>
      </div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map(([t, v, d]) => (
          <div key={t} className="card p-5">
            <p className="text-xs opacity-60">{t}</p>
            <p className="font-display text-3xl mt-1">{v}</p>
            <p className="text-xs opacity-60 mt-1">{d}</p>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card p-5 lg:col-span-2">
          <p className="font-semibold mb-2">Revenue by artist · last 30 days</p>
          {s.revenue_by_staff.length ? (
            <StaffBar
              label="Revenue ₹"
              labels={s.revenue_by_staff.map((x) => x.staff_name.split(' ')[0])}
              values={s.revenue_by_staff.map((x) => Math.round(x.revenue_paise / 100))}
            />
          ) : (
            <p className="text-sm opacity-60">No completed visits yet.</p>
          )}
        </div>

        <div className="card p-5">
          <p className="font-semibold mb-2">Live queue</p>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-4xl">{queue?.now_serving_token ?? '—'}</span>
            <span className="text-xs opacity-60">now serving</span>
          </div>
          <p className="text-sm opacity-70 mt-2">{queue?.waiting_count ?? 0} waiting</p>
          <div className="mt-3 space-y-1 max-h-40 overflow-auto text-sm">
            {(queue?.queue ?? []).slice(0, 6).map((t: any) => (
              <div key={`${t.token_number}-${t.customer_name}`} className="flex justify-between border-b border-line py-1">
                <span>#{t.token_number} {t.customer_name}</span>
                <span className="opacity-60">{t.status.replace('_', ' ')}</span>
              </div>
            ))}
          </div>
          {queue?.walkin_paused && <p className="text-xs text-red-600 mt-2">Remote walk-ins paused</p>}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card p-5">
          <p className="font-semibold mb-2">Today&apos;s appointments</p>
          <div className="space-y-2 max-h-80 overflow-auto">
            {todays.map((b) => (
              <div key={b.id} className="flex justify-between gap-3 text-sm border-b border-line py-2">
                <div>
                  <p className="font-medium">{b.customer_name}</p>
                  <p className="text-xs opacity-60">
                    {new Date(b.scheduled_start_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}
                    {' · '}
                    {b.items.map((i) => i.service_name).join(', ')}
                  </p>
                </div>
                <span className="chip !py-0.5 !px-2 h-fit">{b.status}</span>
              </div>
            ))}
            {!todays.length && <p className="text-sm opacity-60">No bookings today.</p>}
          </div>
        </div>

        <div className="card p-5">
          <p className="font-semibold mb-2">Retention engine</p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-xs opacity-60">Sent</p><p className="font-display text-2xl">{reminders?.summary.sent ?? 0}</p></div>
            <div><p className="text-xs opacity-60">Clicked</p><p className="font-display text-2xl">{reminders?.summary.clicked ?? 0}</p></div>
            <div><p className="text-xs opacity-60">Converted</p><p className="font-display text-2xl">{reminders?.summary.converted_bookings ?? 0}</p></div>
            <div><p className="text-xs opacity-60">Conversion</p><p className="font-display text-2xl">{reminders?.summary.conversion_rate_pct ?? 0}%</p></div>
          </div>
          <div className="mt-3 space-y-1 max-h-40 overflow-auto text-xs">
            {(reminders?.reminders ?? []).slice(0, 5).map((r: any) => (
              <div key={r.id} className="flex justify-between border-b border-line py-1">
                <span>{r.customer_name} · {r.stage.replaceAll('_', ' ')}</span>
                <span className="opacity-60">{r.status.replaceAll('_', ' ')}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
