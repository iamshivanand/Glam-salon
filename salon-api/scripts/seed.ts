import 'dotenv/config';
import pg from 'pg';
import { blindIndex, encrypt } from '../src/crypto.js';

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATE_DATABASE_URL or DATABASE_URL must be set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

const q = (text: string, params: unknown[] = []) => client.query(text, params);
const uid = (prefix: string, n: number) => `${prefix}-${String(n).padStart(12, '0')}`;

const existing = await q('SELECT COUNT(*)::int AS n FROM salons');
if (Number(existing.rows[0].n) > 0) {
  console.log('Seed skipped: salons already exist. Run `npm run db:reset` then migrate + seed for a clean slate.');
  await client.end();
  process.exit(0);
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDate = (offsetDays = 0) =>
  new Date(Date.now() + IST_OFFSET_MS + offsetDays * 86_400_000).toISOString().slice(0, 10);
const istAt = (offsetDays: number, hhmm: string) => new Date(`${istDate(offsetDays)}T${hhmm}:00+05:30`);
const now = new Date();

const USERS = '22222222-2222-4222-8222';
const SALONS = '33333333-3333-4333-8333';
const STAFF = '44444444-4444-4444-8444';
const SERVICES = '55555555-5555-4555-8555';
const BOOKINGS = '66666666-6666-4666-8666';
const INVOICES = '77777777-7777-4777-8777';
const REVIEWS = '88888888-8888-4888-8888';
const RESOURCES = '99999999-9999-4999-8999';
const CATEGORIES = '11111111-1111-4111-8111';

// ---------------------------------------------------------------- users
const people = [
  [uid(USERS, 1), '+919800000001', 'Ananya Rao', 'ananya@glamconnect.dev', 'SALON_OWNER'],
  [uid(USERS, 2), '+919800000002', 'Priya Sharma', 'priya@example.com', 'CUSTOMER'],
  [uid(USERS, 3), '+919800000003', 'Neha Verma', 'neha@example.com', 'CUSTOMER'],
  [uid(USERS, 4), '+919800000004', 'Kavya Iyer', 'kavya@example.com', 'CUSTOMER'],
  [uid(USERS, 9), '+919800000009', 'Platform Admin', 'admin@glamconnect.dev', 'PLATFORM_ADMIN'],
] as const;

for (const [id, phone, name, email, role] of people) {
  await q(
    `INSERT INTO users (id, phone_e164_encrypted, phone_blind_index, full_name, email, role, status, last_login_at)
     VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, encrypt(phone), blindIndex(phone), name, email, role],
  );
}

// ---------------------------------------------------------------- categories
const categories = [
  [uid(CATEGORIES, 1), 'Hair', 'hair', 30, 1],
  [uid(CATEGORIES, 2), 'Skin & Facials', 'skin-facials', 25, 2],
  [uid(CATEGORIES, 3), 'Nails', 'nails', 21, 3],
  [uid(CATEGORIES, 4), 'Makeup', 'makeup', 20, 4],
  [uid(CATEGORIES, 5), 'Spa & Massage', 'spa-massage', 28, 5],
  [uid(CATEGORIES, 6), 'Bridal', 'bridal', 45, 6],
] as const;

for (const [id, name, slug, reminder, order] of categories) {
  await q(
    `INSERT INTO service_categories (id, name, slug, default_reminder_interval_days, display_order)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    [id, name, slug, reminder, order],
  );
}

// ---------------------------------------------------------------- salons
const HOURS = {
  Mon: { open: '10:00', close: '20:00' },
  Tue: { open: '10:00', close: '20:00' },
  Wed: { open: '10:00', close: '20:00' },
  Thu: { open: '10:00', close: '20:00' },
  Fri: { open: '10:00', close: '20:00' },
  Sat: { open: '09:00', close: '21:00' },
  Sun: { open: null, close: null },
};

const salons = [
  {
    id: uid(SALONS, 1),
    name: 'Glam Studio Indiranagar',
    slug: 'glam-studio-indiranagar',
    description: 'A sunlit, women-led studio known for precision cuts, gloss treatments and unhurried facials.',
    type: 'UNISEX',
    address: '12, 100 Feet Road, Indiranagar',
    locality: 'Indiranagar',
    city: 'Bengaluru',
    state: 'Karnataka',
    postal: '560038',
    lat: 12.9719,
    lng: 77.6412,
    rating: 4.8,
    reviews: 214,
    tier: 3,
    sponsored: true,
    factor: 1.0,
    atHome: true,
    hygiene: {
      private: true,
      womenOnly: true,
      wheelchair: true,
      disposable: true,
      autoclave: true,
      parking: true,
    },
  },
  {
    id: uid(SALONS, 2),
    name: 'The Glow Room Koramangala',
    slug: 'the-glow-room-koramangala',
    description: 'Skin-first salon with dermat-guided facials, Korean glass-skin rituals and a calm spa wing.',
    type: 'UNISEX',
    address: '80 Feet Road, 4th Block, Koramangala',
    locality: 'Koramangala',
    city: 'Bengaluru',
    state: 'Karnataka',
    postal: '560034',
    lat: 12.9352,
    lng: 77.6245,
    rating: 4.6,
    reviews: 168,
    tier: 2,
    sponsored: false,
    factor: 0.9,
    atHome: false,
    hygiene: {
      private: true,
      womenOnly: false,
      wheelchair: true,
      disposable: true,
      autoclave: true,
      parking: false,
    },
  },
  {
    id: uid(SALONS, 3),
    name: 'Blush & Bloom HSR',
    slug: 'blush-and-bloom-hsr',
    description: 'Neighbourhood favourite for nail art, party makeup and quick weekday grooming.',
    type: 'WOMEN_ONLY',
    address: '27th Main, Sector 2, HSR Layout',
    locality: 'HSR Layout',
    city: 'Bengaluru',
    state: 'Karnataka',
    postal: '560102',
    lat: 12.9121,
    lng: 77.6446,
    rating: 4.4,
    reviews: 96,
    tier: 1,
    sponsored: false,
    factor: 0.78,
    atHome: true,
    hygiene: {
      private: false,
      womenOnly: true,
      wheelchair: false,
      disposable: true,
      autoclave: false,
      parking: true,
    },
  },
];

for (const s of salons) {
  await q(
    `INSERT INTO salons
       (id, owner_id, name, slug, description, salon_type, verification_status, address_line, locality,
        city, state, postal_code, geo_point, operating_hours, accepts_instant_booking, accepts_walkins,
        walkin_paused, supports_at_home, at_home_radius_km, avg_rating, review_count, price_tier,
        is_sponsored, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,'APPROVED',$7,$8,$9,$10,$11,
             ST_SetSRID(ST_MakePoint($12,$13),4326)::geography, $14, TRUE, TRUE, FALSE, $15, $16,
             $17, $18, $19, $20, TRUE)`,
    [
      s.id,
      uid(USERS, 1),
      s.name,
      s.slug,
      s.description,
      s.type,
      s.address,
      s.locality,
      s.city,
      s.state,
      s.postal,
      s.lng,
      s.lat,
      JSON.stringify(HOURS),
      s.atHome,
      s.atHome ? 8 : 0,
      s.rating,
      s.reviews,
      s.tier,
      s.sponsored,
    ],
  );

  await q(
    `INSERT INTO salon_hygiene_facilities
       (salon_id, has_private_room, has_women_only_zone, wheelchair_accessible, uses_disposable_kits,
        autoclave_sterilization, ac_available, parking_available, hygiene_checklist_json,
        verified_by_admin_id, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$9,NOW())`,
    [
      s.id,
      s.hygiene.private,
      s.hygiene.womenOnly,
      s.hygiene.wheelchair,
      s.hygiene.disposable,
      s.hygiene.autoclave,
      s.hygiene.parking,
      JSON.stringify({
        tools_sanitised_daily: true,
        linens_changed_per_client: true,
        staff_trained_on_hygiene: true,
        waste_segregation: true,
      }),
      uid(USERS, 9),
    ],
  );

  await q(
    `INSERT INTO salon_commission_configs
       (salon_id, plan_tier, marketplace_new_client_bps, repeat_crm_client_bps, saas_monthly_fee_paise)
     VALUES ($1,'STANDARD_COMMISSION',1500,500,0)`,
    [s.id],
  );

  await q(
    `INSERT INTO salon_kyc_verifications
       (salon_id, pan_number_encrypted, gstin, bank_account_encrypted, bank_ifsc, status,
        reviewed_by_admin_id, reviewed_at)
     VALUES ($1,$2,$3,$4,$5,'APPROVED',$6,NOW())`,
    [
      s.id,
      encrypt(`ABCDE${1000 + Math.floor(Math.random() * 8999)}F`),
      '29ABCDE1234F1Z5',
      encrypt('001122334455'),
      'HDFC0001234',
      uid(USERS, 9),
    ],
  );
}

// ---------------------------------------------------------------- catalog
const serviceTemplates = [
  { cat: 0, name: 'Signature Haircut & Blow-dry', price: 120000, duration: 60, reminder: 30 },
  { cat: 0, name: 'Global Hair Colour', price: 450000, duration: 120, reminder: 45, discount: 0.9 },
  { cat: 1, name: 'Glow Facial', price: 250000, duration: 60, reminder: 25 },
  { cat: 1, name: 'Hydra Brightening Facial', price: 380000, duration: 75, reminder: 28, discount: 0.92 },
  { cat: 2, name: 'Gel Manicure', price: 150000, duration: 45, reminder: 21 },
  { cat: 2, name: 'Luxury Pedicure', price: 180000, duration: 60, reminder: 21 },
  { cat: 3, name: 'Party Makeup', price: 350000, duration: 90, reminder: 20 },
  { cat: 4, name: 'Aroma Body Massage', price: 300000, duration: 60, reminder: 28, resource: 'SPA_ROOM' },
  { cat: 5, name: 'Bridal Trial Makeup', price: 800000, duration: 120, reminder: 45, resource: 'MAKEUP_STATION' },
];

const serviceIdsBySalon = new Map<string, string[]>();
let serviceCounter = 0;

for (const [salonIdx, s] of salons.entries()) {
  const ids: string[] = [];
  for (const [i, t] of serviceTemplates.entries()) {
    serviceCounter += 1;
    const id = uid(SERVICES, serviceCounter);
    ids.push(id);
    const base = Math.round((t.price * s.factor) / 1000) * 1000;
    const discounted = t.discount ? Math.round((base * t.discount) / 1000) * 1000 : null;
    await q(
      `INSERT INTO salon_services
         (id, salon_id, category_id, custom_name, description, pricing_model, base_price_paise,
          discounted_price_paise, duration_mins, buffer_after_mins, reminder_interval_days,
          requires_resource_type, available_for_home_visit, is_active)
       VALUES ($1,$2,$3,$4,$5,'FIXED',$6,$7,$8,5,$9,$10,$11,TRUE)`,
      [
        id,
        s.id,
        uid(CATEGORIES, t.cat + 1),
        t.name,
        `${t.name} at ${s.name}, performed by our senior team.`,
        base,
        discounted,
        t.duration,
        t.reminder,
        t.resource ?? null,
        s.atHome && [0, 1, 2, 3].includes(t.cat),
      ],
    );
  }
  serviceIdsBySalon.set(s.id, ids);
}

// add-on example: hair colour + haircut bundle in salon 1
{
  const ids = serviceIdsBySalon.get(salons[0].id)!;
  await q(
    `INSERT INTO salon_service_addons (salon_id, primary_service_id, addon_service_id, bundle_discount_paise, priority_rank)
     VALUES ($1,$2,$3,25000,1) ON CONFLICT DO NOTHING`,
    [salons[0].id, ids[1], ids[0]],
  );
}

// ---------------------------------------------------------------- resources
const resourceMap = new Map<string, string[]>();
let resourceCounter = 0;
for (const [salonIdx, s] of salons.entries()) {
  const ids: string[] = [];
  const types = salonIdx === 0 ? ['SPA_ROOM', 'SPA_ROOM', 'MAKEUP_STATION'] : ['SPA_ROOM', 'MAKEUP_STATION'];
  for (const [i, type] of types.entries()) {
    resourceCounter += 1;
    const id = uid(RESOURCES, resourceCounter);
    ids.push(id);
    await q(
      `INSERT INTO salon_resources (id, salon_id, name, resource_type)
       VALUES ($1,$2,$3,$4)`,
      [id, s.id, `${type === 'SPA_ROOM' ? 'Spa Room' : 'Makeup Station'} ${i + 1}`, type],
    );
  }
  resourceMap.set(s.id, ids);
}

// ---------------------------------------------------------------- staff
const staffNames = [
  ['Ritika Menon', 'Senior hair stylist'],
  ['Aisha Khan', 'Skin & facial specialist'],
  ['Sneha Kulkarni', 'Nail artist'],
  ['Divya Nair', 'Makeup artist'],
  ['Meera Joshi', 'Massage therapist'],
  ['Tanvi Desai', 'Bridal consultant'],
];
const staffIdsBySalon = new Map<string, string[]>();
let staffCounter = 0;

for (const [salonIdx, s] of salons.entries()) {
  const ids: string[] = [];
  for (let k = 0; k < 2; k++) {
    staffCounter += 1;
    const id = uid(STAFF, staffCounter);
    ids.push(id);
    const [name, spec] = staffNames[(salonIdx * 2 + k) % staffNames.length];
    await q(
      `INSERT INTO staff_members
         (id, salon_id, display_name, specialization, experience_years, is_bgv_verified,
          home_visit_enabled, commission_share_bps, avg_rating, review_count, is_active)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6,1000,$7,$8,TRUE)`,
      [id, s.id, name, spec, 4 + k * 3, s.atHome, 4.5 + k * 0.2, 40 + k * 10],
    );

    for (let dow = 0; dow <= 6; dow++) {
      const working = dow !== 0;
      await q(
        `INSERT INTO staff_schedules (staff_id, day_of_week, shift_start, shift_end, breaks_json, is_working_day)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          dow,
          dow === 6 ? '09:00' : '10:00',
          dow === 6 ? '21:00' : '20:00',
          JSON.stringify(working ? [{ start: '13:00', end: '14:00' }] : []),
          working,
        ],
      );
    }

    for (const serviceId of serviceIdsBySalon.get(s.id)!) {
      await q(`INSERT INTO staff_service_mapping (staff_id, salon_service_id) VALUES ($1,$2)`, [id, serviceId]);
    }
  }
  staffIdsBySalon.set(s.id, ids);
}

// ---------------------------------------------------------------- consents
for (const customer of [uid(USERS, 2), uid(USERS, 3), uid(USERS, 4)]) {
  for (const purpose of ['RETENTION_REMINDER', 'PROMOTIONAL_OFFERS']) {
    await q(
      `INSERT INTO customer_consents (user_id, salon_id, channel, purpose, is_granted)
       VALUES ($1,$2,'WHATSAPP',$3,TRUE)
       ON CONFLICT DO NOTHING`,
      [customer, salons[0].id, purpose],
    );
  }
}

// ---------------------------------------------------------------- bookings & invoices
interface SeedService {
  id: string;
  name: string;
  price: number;
  duration: number;
}

async function insertBooking(opts: {
  id: string;
  code: string;
  key: string;
  customerId: string;
  salonId: string;
  staffId: string;
  start: Date;
  status: string;
  services: SeedService[];
  createdAt: Date;
  pin?: string;
}) {
  const end = new Date(opts.start.getTime() + opts.services.reduce((s, x) => s + x.duration * 60_000, 0));
  const subtotal = opts.services.reduce((s, x) => s + x.price, 0);

  await q(
    `INSERT INTO bookings
       (id, booking_code, idempotency_key, customer_id, salon_id, mode, channel, status,
        scheduled_start_at, scheduled_end_at, checkin_pin, subtotal_paise, discount_paise, tax_paise,
        booking_fee_paise, total_payable_paise, created_at)
     VALUES ($1,$2,$3,$4,$5,'IN_SALON','CUSTOMER_APP',$6,$7,$8,$9,$10,0,0,0,$10,$11)`,
    [
      opts.id,
      opts.code,
      opts.key,
      opts.customerId,
      opts.salonId,
      opts.status,
      opts.start,
      end,
      opts.pin ?? '1234',
      subtotal,
      opts.createdAt,
    ],
  );

  let cursor = opts.start.getTime();
  for (const svc of opts.services) {
    const itemStart = new Date(cursor);
    const itemEnd = new Date(cursor + svc.duration * 60_000);
    cursor = itemEnd.getTime() + 5 * 60_000;
    await q(
      `INSERT INTO booking_items
         (booking_id, salon_service_id, staff_id, service_name_snapshot, unit_price_paise,
          duration_mins, time_range, status)
       VALUES ($1,$2,$3,$4,$5,$6, tstzrange($7,$8,'[)'), $9)`,
      [opts.id, svc.id, opts.staffId, svc.name, svc.price, svc.duration, itemStart, itemEnd, opts.status],
    );
  }
  return { subtotal, end };
}

async function insertInvoice(opts: {
  id: string;
  number: string;
  key: string;
  salonId: string;
  customerId: string;
  bookingId: string | null;
  gross: number;
  commissionBps: number;
  createdAt: Date;
  method: string;
}) {
  const tax = 0;
  const net = opts.gross + tax;
  const commission = Math.round((net * opts.commissionBps) / 10000);
  await q(
    `INSERT INTO invoices_and_payments
       (id, invoice_number, idempotency_key, salon_id, customer_id, booking_id,
        gross_amount_paise, discount_paise, loyalty_redeemed_paise, wallet_redeemed_paise, tax_paise,
        net_collected_paise, platform_commission_paise, partner_net_settlement_paise, method, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,0,$8,$9,$10,$11,$12,'CAPTURED',$13)`,
    [
      opts.id,
      opts.number,
      opts.key,
      opts.salonId,
      opts.customerId,
      opts.bookingId,
      opts.gross,
      tax,
      net,
      commission,
      net - commission,
      opts.method,
      opts.createdAt,
    ],
  );
  return { net, commission };
}

const salon1 = salons[0];
const salon2 = salons[1];
const s1 = serviceIdsBySalon.get(salon1.id)!;
const s2 = serviceIdsBySalon.get(salon2.id)!;
const st1 = staffIdsBySalon.get(salon1.id)!;
const st2 = staffIdsBySalon.get(salon2.id)!;
const salon3 = salons[2];
const s3 = serviceIdsBySalon.get(salon3.id)!;
const st3 = staffIdsBySalon.get(salon3.id)!;
const customer2 = uid(USERS, 2);
const customer3 = uid(USERS, 3);
const customer4 = uid(USERS, 4);

// Completed visit A — 3 days ago, salon 1
const bookingA = await insertBooking({
  id: uid(BOOKINGS, 1),
  code: 'GC-2026-0001',
  key: 'seed-booking-0001',
  customerId: customer2,
  salonId: salon1.id,
  staffId: st1[0],
  start: istAt(-3, '11:00'),
  status: 'COMPLETED',
  createdAt: istAt(-4, '09:12'),
  services: [
    { id: s1[0], name: serviceTemplates[0].name, price: 120000, duration: 60 },
    { id: s1[2], name: serviceTemplates[2].name, price: 250000, duration: 60 },
  ],
});
await insertInvoice({
  id: uid(INVOICES, 1),
  number: 'INV-GC-2026-0001',
  key: 'seed-invoice-0001',
  salonId: salon1.id,
  customerId: customer2,
  bookingId: uid(BOOKINGS, 1),
  gross: bookingA.subtotal,
  commissionBps: 500,
  createdAt: istAt(-3, '13:05'),
  method: 'UPI_QR',
});

// Completed visit B — 12 days ago, salon 1
const bookingB = await insertBooking({
  id: uid(BOOKINGS, 2),
  code: 'GC-2026-0002',
  key: 'seed-booking-0002',
  customerId: customer3,
  salonId: salon1.id,
  staffId: st1[1],
  start: istAt(-12, '16:00'),
  status: 'COMPLETED',
  createdAt: istAt(-13, '18:40'),
  services: [{ id: s1[3], name: serviceTemplates[3].name, price: 350000, duration: 75 }],
});
await insertInvoice({
  id: uid(INVOICES, 2),
  number: 'INV-GC-2026-0002',
  key: 'seed-invoice-0002',
  salonId: salon1.id,
  customerId: customer3,
  bookingId: uid(BOOKINGS, 2),
  gross: bookingB.subtotal,
  commissionBps: 1500,
  createdAt: istAt(-12, '17:25'),
  method: 'CARD',
});

// Completed visit C — 20 days ago, salon 2
const bookingC = await insertBooking({
  id: uid(BOOKINGS, 3),
  code: 'GC-2026-0003',
  key: 'seed-booking-0003',
  customerId: customer2,
  salonId: salon2.id,
  staffId: st2[1],
  start: istAt(-20, '12:00'),
  status: 'COMPLETED',
  createdAt: istAt(-21, '08:30'),
  services: [{ id: s2[4], name: serviceTemplates[4].name, price: 135000, duration: 45 }],
});
await insertInvoice({
  id: uid(INVOICES, 3),
  number: 'INV-GC-2026-0003',
  key: 'seed-invoice-0003',
  salonId: salon2.id,
  customerId: customer2,
  bookingId: uid(BOOKINGS, 3),
  gross: bookingC.subtotal,
  commissionBps: 500,
  createdAt: istAt(-20, '13:00'),
  method: 'CASH',
});

// Completed visits at salon 3 so every salon has review rows behind its rating.
const bookingD = await insertBooking({
  id: uid(BOOKINGS, 5),
  code: 'GC-2026-0005',
  key: 'seed-booking-0005',
  customerId: customer3,
  salonId: salon3.id,
  staffId: st3[0],
  start: istAt(-8, '11:30'),
  status: 'COMPLETED',
  createdAt: istAt(-9, '16:10'),
  services: [{ id: s3[0], name: serviceTemplates[0].name, price: 120000, duration: 60 }],
});
await insertInvoice({
  id: uid(INVOICES, 4),
  number: 'INV-GC-2026-0005',
  key: 'seed-invoice-0005',
  salonId: salon3.id,
  customerId: customer3,
  bookingId: uid(BOOKINGS, 5),
  gross: bookingD.subtotal,
  commissionBps: 500,
  createdAt: istAt(-8, '12:45'),
  method: 'UPI_QR',
});

const bookingE = await insertBooking({
  id: uid(BOOKINGS, 6),
  code: 'GC-2026-0006',
  key: 'seed-booking-0006',
  customerId: customer4,
  salonId: salon3.id,
  staffId: st3[1],
  start: istAt(-15, '15:00'),
  status: 'COMPLETED',
  createdAt: istAt(-16, '10:20'),
  services: [{ id: s3[1], name: serviceTemplates[1].name, price: 450000, duration: 120 }],
});
await insertInvoice({
  id: uid(INVOICES, 5),
  number: 'INV-GC-2026-0006',
  key: 'seed-invoice-0006',
  salonId: salon3.id,
  customerId: customer4,
  bookingId: uid(BOOKINGS, 6),
  gross: bookingE.subtotal,
  commissionBps: 500,
  createdAt: istAt(-15, '16:40'),
  method: 'CASH',
});

// Today's confirmed visit for the partner calendar
await insertBooking({
  id: uid(BOOKINGS, 4),
  code: 'GC-2026-0004',
  key: 'seed-booking-0004',
  customerId: customer4,
  salonId: salon1.id,
  staffId: st1[0],
  start: istAt(0, '16:00'),
  status: 'CONFIRMED',
  createdAt: istAt(-1, '19:05'),
  services: [{ id: s1[2], name: serviceTemplates[2].name, price: 250000, duration: 60 }],
});

// ---------------------------------------------------------------- reviews
await q(
  `INSERT INTO reviews
     (id, booking_id, salon_id, customer_id, staff_id, overall_rating, hygiene_rating, review_text, created_at)
   VALUES ($1,$2,$3,$4,$5,5,5,$6,$7)`,
  [
    uid(REVIEWS, 1),
    uid(BOOKINGS, 1),
    salon1.id,
    customer2,
    st1[0],
    'Ritika understood exactly what I wanted. The studio was spotless and the facial left my skin glowing.',
    istAt(-2, '10:00'),
  ],
);
await q(
  `INSERT INTO reviews
     (id, booking_id, salon_id, customer_id, staff_id, overall_rating, hygiene_rating, review_text,
      resolution_status, created_at)
   VALUES ($1,$2,$3,$4,$5,4,4,$6,'NONE',$7)`,
  [
    uid(REVIEWS, 2),
    uid(BOOKINGS, 2),
    salon1.id,
    customer3,
    st1[1],
    'Lovely hydra facial, though I waited about ten minutes past my slot.',
    istAt(-11, '09:15'),
  ],
);
await q(
  `INSERT INTO reviews
     (id, booking_id, salon_id, customer_id, staff_id, overall_rating, hygiene_rating, review_text, created_at)
   VALUES ($1,$2,$3,$4,$5,5,4,$6,$7)`,
  [
    uid(REVIEWS, 3),
    uid(BOOKINGS, 3),
    salon2.id,
    customer2,
    st2[1],
    'Best gel manicure I have had in Koramangala. Booking on Glam Connect took seconds.',
    istAt(-19, '11:30'),
  ],
);

await q(
  `INSERT INTO reviews
     (id, booking_id, salon_id, customer_id, staff_id, overall_rating, hygiene_rating, review_text, created_at)
   VALUES ($1,$2,$3,$4,$5,4,5,$6,$7)`,
  [
    uid(REVIEWS, 4),
    uid(BOOKINGS, 5),
    salon3.id,
    customer3,
    st3[0],
    'Quick, friendly and spotless. The haircut was exactly the shape I asked for.',
    istAt(-7, '09:40'),
  ],
);
await q(
  `INSERT INTO reviews
     (id, booking_id, salon_id, customer_id, staff_id, overall_rating, hygiene_rating, review_text, created_at)
   VALUES ($1,$2,$3,$4,$5,5,4,$6,$7)`,
  [
    uid(REVIEWS, 5),
    uid(BOOKINGS, 6),
    salon3.id,
    customer4,
    st3[1],
    'Lovely colour result and a very calm studio. Will book again.',
    istAt(-14, '12:05'),
  ],
);

await q(
  `UPDATE salons s SET avg_rating = sub.avg_rating, review_count = sub.cnt
     FROM (SELECT salon_id, ROUND(AVG(overall_rating)::numeric,2) AS avg_rating, COUNT(*)::int AS cnt
             FROM reviews GROUP BY salon_id) sub
    WHERE s.id = sub.salon_id`,
);
await q(
  `UPDATE staff_members sm SET avg_rating = sub.avg_rating, review_count = sub.cnt
     FROM (SELECT staff_id, ROUND(AVG(overall_rating)::numeric,2) AS avg_rating, COUNT(*)::int AS cnt
             FROM reviews WHERE staff_id IS NOT NULL GROUP BY staff_id) sub
    WHERE sm.id = sub.staff_id`,
);

// ---------------------------------------------------------------- CRM + loyalty ledger
const crmRows = [
  {
    salonId: salon1.id,
    customerId: customer2,
    visits: 4,
    spend: 1420000,
    interval: 27,
    segment: 'REGULAR',
    lastVisit: istAt(-3, '13:00'),
    points: 142,
    staff: st1[0],
  },
  {
    salonId: salon1.id,
    customerId: customer3,
    visits: 1,
    spend: 350000,
    interval: 25,
    segment: 'NEW',
    lastVisit: istAt(-12, '17:25'),
    points: 35,
    staff: st1[1],
  },
  {
    salonId: salon1.id,
    customerId: customer4,
    visits: 6,
    spend: 2210000,
    interval: 24,
    segment: 'AT_RISK',
    lastVisit: istAt(-48, '12:00'),
    points: 221,
    staff: st1[0],
  },
  {
    salonId: salon2.id,
    customerId: customer2,
    visits: 1,
    spend: 135000,
    interval: 21,
    segment: 'NEW',
    lastVisit: istAt(-20, '13:00'),
    points: 13,
    staff: st2[1],
  },
];

for (const row of crmRows) {
  await q(
    `INSERT INTO salon_customer_crm
       (salon_id, customer_id, custom_customer_code, preferred_staff_id, first_visit_at, last_visit_at,
        next_expected_visit_date, total_visits, total_spend_paise, avg_bill_paise,
        computed_visit_interval_days, retention_segment, loyalty_points_balance, style_preferences_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (salon_id, customer_id) DO NOTHING`,
    [
      row.salonId,
      row.customerId,
      `CUST-${row.customerId.slice(-4).toUpperCase()}`,
      row.staff,
      row.lastVisit,
      row.lastVisit,
      istDate(-3 + row.interval),
      row.visits,
      row.spend,
      Math.round(row.spend / row.visits),
      row.interval,
      row.segment,
      row.points,
      JSON.stringify({
        preferred_length: 'shoulder',
        hair_type: 'wavy',
        allergies: [],
        notes: row.segment === 'AT_RISK' ? 'Prefers evening slots; loves aroma massage.' : 'Loves a glass-skin finish.',
      }),
    ],
  );
}

const ledgerRows = [
  ['seed-ledger-0001', salon1.id, customer2, uid(INVOICES, 1), 'EARN_VISIT', 37, 142],
  ['seed-ledger-0002', salon1.id, customer3, uid(INVOICES, 2), 'EARN_VISIT', 35, 35],
  ['seed-ledger-0003', salon2.id, customer2, uid(INVOICES, 3), 'EARN_VISIT', 13, 13],
];
for (const [key, salonId, customerId, invoiceId, entryType, delta, balance] of ledgerRows) {
  await q(
    `INSERT INTO customer_value_ledger
       (idempotency_key, salon_id, customer_id, invoice_id, bucket, entry_type, amount_delta, balance_after, created_at)
     VALUES ($1,$2,$3,$4,'LOYALTY_POINTS',$5,$6,$7,$8)`,
    [key, salonId, customerId, invoiceId, entryType, delta, balance, istAt(-3, '13:06')],
  );
}

// ---------------------------------------------------------------- reminders
const reminders = [
  {
    salonId: salon1.id,
    customerId: customer2,
    bookingId: uid(BOOKINGS, 1),
    categoryId: uid(CATEGORIES, 1),
    stage: 'DAY_25_INVITE',
    scheduled: istAt(2, '10:00'),
    status: 'SCHEDULED',
    template: 'WA_INVITE_BOOK_V1',
  },
  {
    salonId: salon1.id,
    customerId: customer3,
    bookingId: uid(BOOKINGS, 2),
    categoryId: uid(CATEGORIES, 2),
    stage: 'DAY_20_GENTLE',
    scheduled: istAt(-2, '10:00'),
    status: 'SENT',
    template: 'WA_GENTLE_DUE_V1',
  },
  {
    salonId: salon1.id,
    customerId: customer2,
    bookingId: uid(BOOKINGS, 1),
    categoryId: uid(CATEGORIES, 1),
    stage: 'DAY_35_REENGAGE',
    scheduled: istAt(-9, '10:00'),
    status: 'CONVERTED_TO_BOOKING',
    template: 'WA_REENGAGE_V1',
  },
];

let reminderCounter = 0;
for (const r of reminders) {
  reminderCounter += 1;
  await q(
    `INSERT INTO retention_reminders
       (salon_id, customer_id, source_booking_id, service_category_id, stage, channel, scheduled_for,
        status, template_code, deep_link_token, sent_at, attributed_booking_id)
     VALUES ($1,$2,$3,$4,$5,'WHATSAPP',$6,$7,$8,$9,$10,$11)`,
    [
      r.salonId,
      r.customerId,
      r.bookingId,
      r.categoryId,
      r.stage,
      r.scheduled,
      r.status,
      r.template,
      `seedtoken${String(reminderCounter).padStart(8, '0')}`,
      r.status === 'SCHEDULED' ? null : r.scheduled,
      r.status === 'CONVERTED_TO_BOOKING' ? uid(BOOKINGS, 1) : null,
    ],
  );
}

// ---------------------------------------------------------------- walk-in queue
await q(
  `INSERT INTO walkin_queue_tokens
     (salon_id, customer_id, walkin_customer_name, selected_service_ids, total_duration_mins,
      queue_date, token_number, status, estimated_wait_mins, joined_at)
   VALUES ($1,$2,$3,$4::uuid[],60,$5,1,'WAITING',20,$6)`,
  [salon1.id, customer4, 'Kavya Iyer', [s1[0]], istDate(0), new Date()],
);
await q(
  `INSERT INTO walkin_queue_tokens
     (salon_id, walkin_customer_name, selected_service_ids, total_duration_mins,
      queue_date, token_number, status, estimated_wait_mins, joined_at, called_at)
   VALUES ($1,$2,$3::uuid[],45,$4,2,'CALLED',5,$5,$6)`,
  [salon1.id, 'Walk-in Guest', [s1[4]], istDate(0), new Date(), new Date()],
);

await client.end();

console.log(`
Seed complete.

Demo accounts (OTP is returned in the API response in dev):
  Salon owner   +91 98000 00001  (Ananya Rao)
  Customer      +91 98000 00002  (Priya Sharma)
  Customer      +91 98000 00003  (Neha Verma)
  Platform admin +91 98000 00009

Salons: ${salons.map((s) => s.name).join(' | ')}
Today (IST): ${istDate(0)}
`);
