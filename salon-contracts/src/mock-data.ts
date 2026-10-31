import type { Appointment, Customer, DashboardStats, Offer, Review, Salon, Service, ServiceCategory, Staff } from './types';

export const salon: Salon = {
  id: 'salon-1',
  name: 'Glam Connect',
  address: '21 Rosewater Lane, Indiranagar, Bengaluru',
  phone: '+91 98765 43210',
  rating: 4.8,
  reviewsCount: 2_314,
  images: [
    'https://images.unsplash.com/photo-1560066984-138dadb4c035?w=1200',
    'https://images.unsplash.com/photo-1522337660859-02fbefca4702?w=1200',
    'https://images.unsplash.com/photo-1487412947147-5cebf100ffc2?w=1200',
  ],
};

export const categories: ServiceCategory[] = [
  { id: 'cat-hair', name: 'Hair', icon: '✂️' },
  { id: 'cat-skin', name: 'Skin', icon: '✨' },
  { id: 'cat-nails', name: 'Nails', icon: '💅' },
  { id: 'cat-spa', name: 'Spa', icon: '🧖' },
  { id: 'cat-beard', name: 'Beard', icon: '🧔' },
  { id: 'cat-bridal', name: 'Bridal', icon: '👰' },
];

export const staff: Staff[] = [
  { id: 'st-1', name: 'Aisha Khan', role: 'Senior Stylist', avatar: 'https://i.pravatar.cc/200?img=47', rating: 4.9, reviewsCount: 412, specialties: ['Balayage', 'Keratine'], color: '#C9A86A' },
  { id: 'st-2', name: 'Rohan Mehta', role: 'Master Barber', avatar: 'https://i.pravatar.cc/200?img=12', rating: 4.8, reviewsCount: 358, specialties: ['Fade', 'Beard Sculpt'], color: '#7D8C7A' },
  { id: 'st-3', name: 'Sofia D’Souza', role: 'Skin Expert', avatar: 'https://i.pravatar.cc/200?img=32', rating: 4.9, reviewsCount: 502, specialties: ['HydraFacial', 'Clean-up'], color: '#B76E79' },
  { id: 'st-4', name: 'Priya Nair', role: 'Nail Artist', avatar: 'https://i.pravatar.cc/200?img=44', rating: 4.7, reviewsCount: 289, specialties: ['Gel-X', 'Nail Art'], color: '#8E7CC3' },
  { id: 'st-5', name: 'Arjun Rao', role: 'Spa Therapist', avatar: 'https://i.pravatar.cc/200?img=59', rating: 4.8, reviewsCount: 301, specialties: ['Deep Tissue', 'Aroma'], color: '#6FA8A0' },
  { id: 'st-6', name: 'Kavya Reddy', role: 'Bridal MUA', avatar: 'https://i.pravatar.cc/200?img=26', rating: 5.0, reviewsCount: 198, specialties: ['HD Bridal', 'Party'], color: '#D4A373' },
];

export const services: Service[] = [
  { id: 'sv-1', categoryId: 'cat-hair', name: 'Signature Haircut', desc: 'Consult + cut + wash + style', price: 899, durationMin: 45, image: 'https://images.unsplash.com/photo-1562322140-8baeececf3df?w=800', popular: true, staffIds: ['st-1', 'st-2'] },
  { id: 'sv-2', categoryId: 'cat-hair', name: 'Balayage + Gloss', desc: 'Hand-painted colour + toner + spa', price: 5999, durationMin: 180, image: 'https://images.unsplash.com/photo-1522337660859-02fbefca4702?w=800', popular: true, staffIds: ['st-1'] },
  { id: 'sv-3', categoryId: 'cat-skin', name: 'HydraGlow Facial', desc: 'Deep cleanse + exfoliate + hydration', price: 2499, durationMin: 60, image: 'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800', popular: true, staffIds: ['st-3'] },
  { id: 'sv-4', categoryId: 'cat-nails', name: 'Gel-X Extensions', desc: 'Extensions + art + cuticle care', price: 1799, durationMin: 90, image: 'https://images.unsplash.com/photo-1604654894610-df63bc536371?w=800', staffIds: ['st-4'] },
  { id: 'sv-5', categoryId: 'cat-spa', name: 'Aroma Massage 60m', desc: 'Full-body essential-oil ritual', price: 2999, durationMin: 60, image: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800', staffIds: ['st-5'] },
  { id: 'sv-6', categoryId: 'cat-beard', name: 'Beard Sculpt + Facial', desc: 'Shape + hot towel + de-tan', price: 799, durationMin: 40, image: 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800', staffIds: ['st-2'] },
  { id: 'sv-7', categoryId: 'cat-bridal', name: 'Bridal HD Package', desc: 'Trial + HD makeup + hair + drape', price: 14999, durationMin: 240, image: 'https://images.unsplash.com/photo-1487412947147-5cebf100ffc2?w=800', popular: true, staffIds: ['st-6', 'st-1'] },
  { id: 'sv-8', categoryId: 'cat-skin', name: 'Express Clean-up', desc: '30-min glow refresh', price: 999, durationMin: 30, image: 'https://images.unsplash.com/photo-1512290923902-8a9f81dc236c?w=800', staffIds: ['st-3'] },
];

export const customers: Customer[] = Array.from({ length: 45 }, (_, i) => ({
  id: `cu-${i + 1}`,
  name: ['Ananya Sharma', 'Vikram Malhotra', 'Ishita Bose', 'Karan Patel', 'Meera Iyer'][i % 5] + ` ${Math.floor(i / 5) + 1}`,
  phone: `+91 98${String(10000000 + i * 137913).slice(0, 8)}`,
  avatar: `https://i.pravatar.cc/100?img=${(i % 60) + 1}`,
  loyaltyPoints: 100 + ((i * 137) % 900),
  totalVisits: 1 + ((i * 7) % 24),
  lastVisit: new Date(Date.now() - (i % 20) * 864e5).toISOString(),
}));

export const reviews: Review[] = [
  { id: 'rv-1', customerName: 'Ananya Sharma', serviceName: 'Balayage + Gloss', rating: 5, comment: 'Aisha is magic. Best colour in the city, salon smells divine.', date: '2026-10-10' },
  { id: 'rv-2', customerName: 'Vikram Malhotra', serviceName: 'Beard Sculpt + Facial', rating: 5, comment: 'Sharp fade, zero wait with booking. Very premium feel.', date: '2026-10-08' },
  { id: 'rv-3', customerName: 'Ishita Bose', serviceName: 'HydraGlow Facial', rating: 4, comment: 'Skin glowing for a week. Slight wait on Saturday.', date: '2026-10-05' },
  { id: 'rv-4', customerName: 'Meera Iyer', serviceName: 'Aroma Massage 60m', rating: 5, comment: 'Spa room is world class. Arjun is excellent.', date: '2026-10-01' },
];

export const offers: Offer[] = [
  { id: 'of-1', title: 'Festive Glow — 20% off facials', code: 'GLOW20', discountPct: 20, validTill: '2026-11-15' },
  { id: 'of-2', title: 'First visit flat ₹300 off', code: 'HELLO300', discountPct: 15, validTill: '2026-12-31' },
  { id: 'of-3', title: 'Bridal trial free with package', code: 'BRIDE', discountPct: 10, validTill: '2026-12-01' },
];

// Deterministic pseudo-random so web + mobile show identical charts
function rand(seed: number) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

export function buildAppointments(): Appointment[] {
  const r = rand(42);
  const list: Appointment[] = [];
  const statuses = ['completed', 'completed', 'completed', 'confirmed', 'pending', 'cancelled'] as const;
  for (let d = -30; d < 14; d++) {
    const day = new Date(); day.setDate(day.getDate() + d);
    const n = 2 + Math.floor(r() * 5);
    for (let k = 0; k < n; k++) {
      const sv = services[Math.floor(r() * services.length)];
      const stId = sv.staffIds[Math.floor(r() * sv.staffIds.length)];
      const st = staff.find((s) => s.id === stId)!;
      const cu = customers[Math.floor(r() * customers.length)];
      const hour = 10 + Math.floor(r() * 9);
      const start = new Date(day); start.setHours(hour, r() > 0.5 ? 30 : 0, 0, 0);
      const end = new Date(start.getTime() + sv.durationMin * 6e4);
      list.push({
        id: `ap-${d}-${k}`,
        customerId: cu.id, customerName: cu.name,
        serviceId: sv.id, serviceName: sv.name,
        staffId: st.id, staffName: st.name,
        startAt: start.toISOString(), endAt: end.toISOString(),
        status: d < 0 ? (r() > 0.08 ? 'completed' : 'no-show') : statuses[Math.floor(r() * statuses.length)],
        price: sv.price,
      });
    }
  }
  return list.sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt));
}

export const appointments: Appointment[] = buildAppointments();

export function buildStats(): DashboardStats {
  const byDay = new Map<string, { revenue: number; bookings: number }>();
  for (const a of appointments) {
    if (a.status === 'cancelled') continue;
    const key = a.startAt.slice(0, 10);
    const e = byDay.get(key) ?? { revenue: 0, bookings: 0 };
    e.revenue += a.price; e.bookings += 1;
    byDay.set(key, e);
  }
  const series30d = [...byDay.entries()].slice(-30).map(([date, v]) => ({ date, ...v }));
  const today = new Date().toISOString().slice(0, 10);
  const t = byDay.get(today) ?? { revenue: 0, bookings: 0 };
  const weekRevenue = [...byDay.values()].slice(-7).reduce((s, v) => s + v.revenue, 0);
  const monthRevenue = [...byDay.values()].slice(-30).reduce((s, v) => s + v.revenue, 0);
  return {
    revenueToday: t.revenue, revenueWeek: weekRevenue, revenueMonth: monthRevenue,
    bookingsToday: t.bookings, occupancyPct: 78, avgRating: 4.8, newCustomers: 34,
    revenueDeltaPct: 12.4, bookingsDeltaPct: 8.1,
    series30d,
    byCategory: categories.map((c, i) => ({
      name: c.name,
      value: services.filter((s) => s.categoryId === c.id).length * (14 - i * 2) + 8,
    })),
    byStaff: staff.map((s, i) => ({
      name: s.name.split(' ')[0],
      bookings: 28 - i * 2,
      revenue: (28 - i * 2) * 1400,
    })),
  };
}

export function slotsFor(dateISO: string, staffId?: string): { time: string; available: boolean }[] {
  const r = rand(dateISO.length * 97 + (staffId?.length ?? 0) * 13 + dateISO.charCodeAt(5));
  const out: { time: string; available: boolean }[] = [];
  for (let h = 10; h < 20; h++) {
    for (const m of ['00', '30']) {
      out.push({ time: `${String(h).padStart(2, '0')}:${m}`, available: r() > 0.35 });
    }
  }
  return out;
}
