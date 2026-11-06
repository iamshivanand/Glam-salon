'use client';

import Link from 'next/link';
import { PartnerGate } from '@/components/partner-gate';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <PartnerGate>
      <div className="pt-8 grid lg:grid-cols-[220px_1fr] gap-6">
        <aside className="card p-4 h-fit lg:sticky lg:top-20 flex lg:flex-col gap-2 overflow-x-auto">
          {[
            ['Overview', '/admin'],
            ['Calendar', '/admin/calendar'],
            ['Bookings', '/admin/bookings'],
            ['Customers', '/admin/crm'],
            ['Reviews', '/admin/reviews'],
            ['Retention', '/admin/reminders'],
            ['Invoices', '/admin/invoices'],
            ['Staff', '/admin/staff'],
            ['Services', '/admin/services'],
            ['Resources', '/admin/resources'],
          ].map(([t, h]) => (
            <Link key={h} href={h} className="chip whitespace-nowrap">
              {t}
            </Link>
          ))}
          <div className="hidden lg:block mt-4 pt-4 border-t border-line text-[11px] opacity-50">
            Owner console · Glam Connect
          </div>
        </aside>
        <div>{children}</div>
      </div>
    </PartnerGate>
  );
}
