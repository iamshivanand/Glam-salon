import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one, query, withTenant } from '../db.js';
import { parse, badRequest, notFound, forbidden, conflict } from '../http.js';
import { authenticate, requireRole, salonIdForUser } from '../auth.js';
import { encrypt } from '../crypto.js';
import { dashboard } from '../services/analytics.js';
import { createInvoice } from '../services/invoices.js';
import { listReminders, triggerReminders } from '../services/reminders.js';
import { liveQueue, updateQueueStatus } from '../services/queue.js';
import { fmtLocalDate } from '../services/availability.js';

const PARTNER_ROLES = ['SALON_OWNER', 'SALON_MANAGER', 'STAFF', 'PLATFORM_ADMIN'] as const;
const OWNER_ROLES = ['SALON_OWNER', 'PLATFORM_ADMIN'] as const;

async function resolveSalonId(req: any): Promise<string> {
  const header = req.headers['x-salon-id'];
  const requested = typeof header === 'string' ? header : undefined;
  if (requested) {
    const owned = await one(
      `SELECT id FROM salons WHERE id = $1 AND (owner_id = $2 OR $3 = 'PLATFORM_ADMIN')`,
      [requested, req.auth.id, req.auth.role],
    );
    if (!owned) throw forbidden('You do not manage this salon');
    return requested;
  }
  if (req.auth.salonId) return req.auth.salonId;
  const resolved = await salonIdForUser(req.auth.id);
  if (!resolved) throw forbidden('No salon is linked to this account yet');
  return resolved;
}

function slugify(name: string): string {
  return `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)}-${Math.random().toString(36).slice(2, 7)}`;
}

const DEFAULT_HOURS = {
  Mon: { open: '10:00', close: '20:00' },
  Tue: { open: '10:00', close: '20:00' },
  Wed: { open: '10:00', close: '20:00' },
  Thu: { open: '10:00', close: '20:00' },
  Fri: { open: '10:00', close: '20:00' },
  Sat: { open: '09:00', close: '21:00' },
  Sun: { open: null, close: null },
};

const SalonCreate = z.object({
  name: z.string().min(2).max(150),
  description: z.string().max(2000).optional(),
  salon_type: z.enum(['UNISEX', 'WOMEN_ONLY', 'MEN_ONLY', 'HOME_SERVICE']),
  address_line: z.string().min(3).max(255),
  locality: z.string().min(1).max(120),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(100),
  postal_code: z.string().min(4).max(20),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  operating_hours: z.record(z.object({ open: z.string().nullable(), close: z.string().nullable() })).optional(),
  accepts_instant_booking: z.boolean().optional(),
  accepts_walkins: z.boolean().optional(),
  supports_at_home: z.boolean().optional(),
  at_home_radius_km: z.number().min(0).max(50).optional(),
});

const SalonPatch = SalonCreate.partial().extend({
  is_active: z.boolean().optional(),
  walkin_paused: z.boolean().optional(),
  price_tier: z.number().int().min(1).max(3).optional(),
});

const KycInput = z.object({
  pan_number: z.string().min(10).max(10),
  gstin: z.string().max(20).optional(),
  bank_account_number: z.string().min(6).max(34),
  bank_ifsc: z.string().min(4).max(16),
  shop_license_s3_key: z.string().max(512).optional(),
});

const ServiceInput = z.object({
  category_id: z.string().uuid(),
  custom_name: z.string().min(2).max(150),
  description: z.string().max(2000).optional(),
  pricing_model: z.enum(['FIXED', 'STARTING_FROM_QUOTE']).optional(),
  base_price_paise: z.number().int().min(0),
  discounted_price_paise: z.number().int().min(0).nullish(),
  duration_mins: z.number().int().min(5).max(600),
  buffer_after_mins: z.number().int().min(0).max(120).optional(),
  reminder_interval_days: z.number().int().min(5).max(120).optional(),
  requires_resource_type: z.string().max(50).nullish(),
  available_for_home_visit: z.boolean().optional(),
  quote_questions_schema: z.array(z.any()).optional(),
});

const StaffInput = z.object({
  display_name: z.string().min(1).max(100),
  user_id: z.string().uuid().nullish(),
  specialization: z.string().max(150).optional(),
  experience_years: z.number().int().min(0).max(60).optional(),
  is_bgv_verified: z.boolean().optional(),
  home_visit_enabled: z.boolean().optional(),
  commission_share_bps: z.number().int().min(0).max(10000).optional(),
});

const ScheduleInput = z.object({
  entries: z
    .array(
      z.object({
        day_of_week: z.number().int().min(0).max(6),
        shift_start: z.string().regex(/^\d{2}:\d{2}$/),
        shift_end: z.string().regex(/^\d{2}:\d{2}$/),
        breaks: z.array(z.object({ start: z.string(), end: z.string() })).optional(),
        is_working_day: z.boolean().optional(),
      }),
    )
    .max(7),
});

export const partnerRoutes: FastifyPluginAsync = async (app) => {
  // ---------- Onboarding ----------
  app.post('/partner/salons', { preHandler: [authenticate, requireRole(...OWNER_ROLES)] }, async (req) => {
    const body = parse(SalonCreate, req.body);
    return query(
      `INSERT INTO salons
         (owner_id, name, slug, description, salon_type, address_line, locality, city, state,
          postal_code, geo_point, operating_hours, accepts_instant_booking, accepts_walkins,
          supports_at_home, at_home_radius_km, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, ST_SetSRID(ST_MakePoint($11,$12),4326)::geography,
               $13,$14,$15,$16,$17,'DRAFT')
       RETURNING *`,
      [
        req.auth!.id,
        body.name,
        slugify(body.name),
        body.description ?? null,
        body.salon_type,
        body.address_line,
        body.locality,
        body.city,
        body.state,
        body.postal_code,
        body.lng,
        body.lat,
        JSON.stringify(body.operating_hours ?? DEFAULT_HOURS),
        body.accepts_instant_booking ?? true,
        body.accepts_walkins ?? true,
        body.supports_at_home ?? false,
        body.at_home_radius_km ?? 0,
      ],
    ).then(async (rows) => {
      const salon = rows[0];
      await query(`INSERT INTO salon_hygiene_facilities (salon_id) VALUES ($1) ON CONFLICT DO NOTHING`, [salon.id]);
      await query(
        `INSERT INTO salon_commission_configs (salon_id, plan_tier, marketplace_new_client_bps, repeat_crm_client_bps)
         VALUES ($1, 'STANDARD_COMMISSION', 1500, 0) ON CONFLICT (salon_id) DO NOTHING`,
        [salon.id],
      );
      return salon;
    });
  });

  app.get('/partner/salon', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const salon = await one(`SELECT * FROM salons WHERE id = $1`, [salonId]);
    if (!salon) throw notFound('Salon not found');
    const hygiene = await one(`SELECT * FROM salon_hygiene_facilities WHERE salon_id = $1`, [salonId]);
    const commission = await one(`SELECT * FROM salon_commission_configs WHERE salon_id = $1`, [salonId]);
    const kyc = await one(
      `SELECT id, gstin, bank_ifsc, shop_license_s3_key, status, rejection_reason, reviewed_at
         FROM salon_kyc_verifications WHERE salon_id = $1`,
      [salonId],
    );
    return { ...salon, hygiene_facilities: hygiene, commission_config: commission, kyc: kyc ?? null };
  });

  app.patch('/partner/salon', { preHandler: [authenticate, requireRole(...OWNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const body = parse(SalonPatch, req.body);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    const simple: [keyof typeof body, string][] = [
      ['name', 'name'],
      ['description', 'description'],
      ['salon_type', 'salon_type'],
      ['address_line', 'address_line'],
      ['locality', 'locality'],
      ['city', 'city'],
      ['state', 'state'],
      ['postal_code', 'postal_code'],
      ['accepts_instant_booking', 'accepts_instant_booking'],
      ['accepts_walkins', 'accepts_walkins'],
      ['supports_at_home', 'supports_at_home'],
      ['at_home_radius_km', 'at_home_radius_km'],
      ['is_active', 'is_active'],
      ['walkin_paused', 'walkin_paused'],
      ['price_tier', 'price_tier'],
    ];
    for (const [key, col] of simple) {
      if (body[key] !== undefined) push(col, body[key]);
    }
    if (body.operating_hours !== undefined) push('operating_hours', JSON.stringify(body.operating_hours));
    if (body.lat !== undefined && body.lng !== undefined) {
      params.push(body.lng, body.lat);
      sets.push(`geo_point = ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}),4326)::geography`);
    }
    if (!sets.length) throw badRequest('VALIDATION_ERROR', 'No fields to update');

    params.push(salonId);
    return one(`UPDATE salons SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  });

  app.post('/partner/salon/submit', { preHandler: [authenticate, requireRole(...OWNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const kyc = await one(`SELECT id FROM salon_kyc_verifications WHERE salon_id = $1`, [salonId]);
    if (!kyc) throw badRequest('KYC_REQUIRED', 'Submit PAN, bank details and shop licence before verification');
    return one(
      `UPDATE salons SET verification_status = 'SUBMITTED' WHERE id = $1 RETURNING id, verification_status`,
      [salonId],
    );
  });

  app.post('/partner/kyc', { preHandler: [authenticate, requireRole(...OWNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const body = parse(KycInput, req.body);
    const row = await one(
      `INSERT INTO salon_kyc_verifications
         (salon_id, pan_number_encrypted, gstin, bank_account_encrypted, bank_ifsc,
          shop_license_s3_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,'SUBMITTED')
       ON CONFLICT (salon_id) DO UPDATE SET
         pan_number_encrypted = EXCLUDED.pan_number_encrypted,
         gstin = EXCLUDED.gstin,
         bank_account_encrypted = EXCLUDED.bank_account_encrypted,
         bank_ifsc = EXCLUDED.bank_ifsc,
         shop_license_s3_key = EXCLUDED.shop_license_s3_key,
         status = 'SUBMITTED',
         rejection_reason = NULL
       RETURNING id, gstin, bank_ifsc, shop_license_s3_key, status, updated_at`,
      [
        salonId,
        encrypt(body.pan_number.toUpperCase()),
        body.gstin ?? null,
        encrypt(body.bank_account_number),
        body.bank_ifsc.toUpperCase(),
        body.shop_license_s3_key ?? null,
      ],
    );
    await query(`UPDATE salons SET verification_status = 'SUBMITTED' WHERE id = $1 AND verification_status = 'DRAFT'`, [
      salonId,
    ]);
    return row;
  });

  app.patch('/partner/hygiene', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const body = parse(
      z.object({
        has_private_room: z.boolean().optional(),
        has_women_only_zone: z.boolean().optional(),
        wheelchair_accessible: z.boolean().optional(),
        uses_disposable_kits: z.boolean().optional(),
        autoclave_sterilization: z.boolean().optional(),
        ac_available: z.boolean().optional(),
        parking_available: z.boolean().optional(),
        hygiene_checklist: z.record(z.any()).optional(),
      }),
      req.body,
    );
    return one(
      `INSERT INTO salon_hygiene_facilities
         (salon_id, has_private_room, has_women_only_zone, wheelchair_accessible, uses_disposable_kits,
          autoclave_sterilization, ac_available, parking_available, hygiene_checklist_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (salon_id) DO UPDATE SET
         has_private_room = COALESCE($2, salon_hygiene_facilities.has_private_room),
         has_women_only_zone = COALESCE($3, salon_hygiene_facilities.has_women_only_zone),
         wheelchair_accessible = COALESCE($4, salon_hygiene_facilities.wheelchair_accessible),
         uses_disposable_kits = COALESCE($5, salon_hygiene_facilities.uses_disposable_kits),
         autoclave_sterilization = COALESCE($6, salon_hygiene_facilities.autoclave_sterilization),
         ac_available = COALESCE($7, salon_hygiene_facilities.ac_available),
         parking_available = COALESCE($8, salon_hygiene_facilities.parking_available),
         hygiene_checklist_json = COALESCE($9, salon_hygiene_facilities.hygiene_checklist_json)
       RETURNING *`,
      [
        salonId,
        body.has_private_room ?? null,
        body.has_women_only_zone ?? null,
        body.wheelchair_accessible ?? null,
        body.uses_disposable_kits ?? null,
        body.autoclave_sterilization ?? null,
        body.ac_available ?? null,
        body.parking_available ?? null,
        body.hygiene_checklist ? JSON.stringify(body.hygiene_checklist) : null,
      ],
    );
  });

  // ---------- Catalog ----------
  app.get('/partner/services', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const services = await query(
      `SELECT ss.*, sc.name AS category_name
         FROM salon_services ss JOIN service_categories sc ON sc.id = ss.category_id
        WHERE ss.salon_id = $1 ORDER BY sc.display_order, ss.custom_name`,
      [salonId],
    );
    return { services };
  });

  app.post('/partner/services', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const body = parse(ServiceInput, req.body);
    return one(
      `INSERT INTO salon_services
         (salon_id, category_id, custom_name, description, pricing_model, base_price_paise,
          discounted_price_paise, duration_mins, buffer_after_mins, reminder_interval_days,
          requires_resource_type, available_for_home_visit, quote_questions_schema)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        salonId,
        body.category_id,
        body.custom_name,
        body.description ?? null,
        body.pricing_model ?? 'FIXED',
        body.base_price_paise,
        body.discounted_price_paise ?? null,
        body.duration_mins,
        body.buffer_after_mins ?? 5,
        body.reminder_interval_days ?? 25,
        body.requires_resource_type ?? null,
        body.available_for_home_visit ?? false,
        JSON.stringify(body.quote_questions_schema ?? []),
      ],
    );
  });

  app.patch('/partner/services/:id', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { id } = req.params as { id: string };
    const body = parse(ServiceInput.partial().extend({ is_active: z.boolean().optional() }), req.body);

    const map: [string, unknown][] = [
      ['category_id', body.category_id],
      ['custom_name', body.custom_name],
      ['description', body.description],
      ['pricing_model', body.pricing_model],
      ['base_price_paise', body.base_price_paise],
      ['discounted_price_paise', body.discounted_price_paise],
      ['duration_mins', body.duration_mins],
      ['buffer_after_mins', body.buffer_after_mins],
      ['reminder_interval_days', body.reminder_interval_days],
      ['requires_resource_type', body.requires_resource_type],
      ['available_for_home_visit', body.available_for_home_visit],
      ['is_active', body.is_active],
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [col, value] of map) {
      if (value !== undefined) {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) throw badRequest('VALIDATION_ERROR', 'No fields to update');
    params.push(id, salonId);
    const row = await one(
      `UPDATE salon_services SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND salon_id = $${params.length} RETURNING *`,
      params,
    );
    if (!row) throw notFound('Service not found');
    return row;
  });

  app.delete('/partner/services/:id', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { id } = req.params as { id: string };
    const row = await one(
      `UPDATE salon_services SET is_active = FALSE WHERE id = $1 AND salon_id = $2 RETURNING id`,
      [id, salonId],
    );
    if (!row) throw notFound('Service not found');
    return { ok: true };
  });

  app.post('/partner/services/:id/addons', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        addon_service_id: z.string().uuid(),
        bundle_discount_paise: z.number().int().min(0).optional(),
        priority_rank: z.number().int().min(1).max(20).optional(),
      }),
      req.body,
    );
    return one(
      `INSERT INTO salon_service_addons
         (salon_id, primary_service_id, addon_service_id, bundle_discount_paise, priority_rank)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (primary_service_id, addon_service_id)
       DO UPDATE SET bundle_discount_paise = EXCLUDED.bundle_discount_paise,
                     priority_rank = EXCLUDED.priority_rank
       RETURNING *`,
      [salonId, id, body.addon_service_id, body.bundle_discount_paise ?? 0, body.priority_rank ?? 1],
    );
  });

  // ---------- Staff & resources ----------
  app.get('/partner/staff', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const staff = await query(
      `SELECT s.*,
              COALESCE(json_agg(DISTINCT sc.day_of_week) FILTER (WHERE sc.id IS NOT NULL), '[]') AS working_days
         FROM staff_members s
         LEFT JOIN staff_schedules sc ON sc.staff_id = s.id AND sc.is_working_day = TRUE AND sc.override_date IS NULL
        WHERE s.salon_id = $1
        GROUP BY s.id ORDER BY s.display_name`,
      [salonId],
    );
    return { staff };
  });

  app.post('/partner/staff', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const body = parse(StaffInput, req.body);
    return one(
      `INSERT INTO staff_members
         (salon_id, user_id, display_name, specialization, experience_years, is_bgv_verified,
          home_visit_enabled, commission_share_bps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        salonId,
        body.user_id ?? null,
        body.display_name,
        body.specialization ?? null,
        body.experience_years ?? 0,
        body.is_bgv_verified ?? false,
        body.home_visit_enabled ?? false,
        body.commission_share_bps ?? 0,
      ],
    );
  });

  app.patch('/partner/staff/:id', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { id } = req.params as { id: string };
    const body = parse(StaffInput.partial().extend({ is_active: z.boolean().optional() }), req.body);

    const map: [string, unknown][] = [
      ['display_name', body.display_name],
      ['specialization', body.specialization],
      ['experience_years', body.experience_years],
      ['is_bgv_verified', body.is_bgv_verified],
      ['home_visit_enabled', body.home_visit_enabled],
      ['commission_share_bps', body.commission_share_bps],
      ['is_active', body.is_active],
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [col, value] of map) {
      if (value !== undefined) {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) throw badRequest('VALIDATION_ERROR', 'No fields to update');
    params.push(id, salonId);
    const row = await one(
      `UPDATE staff_members SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND salon_id = $${params.length} RETURNING *`,
      params,
    );
    if (!row) throw notFound('Staff member not found');
    return row;
  });

  app.get('/partner/staff/:id/schedule', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const { id } = req.params as { id: string };
    const entries = await query(`SELECT * FROM staff_schedules WHERE staff_id = $1 ORDER BY day_of_week`, [id]);
    return { entries };
  });

  app.post('/partner/staff/:id/schedule', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { id } = req.params as { id: string };
    const body = parse(ScheduleInput, req.body);

    const staff = await one(`SELECT id FROM staff_members WHERE id = $1 AND salon_id = $2`, [id, salonId]);
    if (!staff) throw notFound('Staff member not found');

    await query(`DELETE FROM staff_schedules WHERE staff_id = $1 AND override_date IS NULL`, [id]);
    for (const entry of body.entries) {
      await query(
        `INSERT INTO staff_schedules (staff_id, day_of_week, shift_start, shift_end, breaks_json, is_working_day)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          entry.day_of_week,
          entry.shift_start,
          entry.shift_end,
          JSON.stringify(entry.breaks ?? []),
          entry.is_working_day ?? true,
        ],
      );
    }
    return { ok: true, entries: body.entries.length };
  });

  app.post('/partner/staff/:id/services', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ service_ids: z.array(z.string().uuid()) }), req.body);

    const staff = await one(`SELECT id FROM staff_members WHERE id = $1 AND salon_id = $2`, [id, salonId]);
    if (!staff) throw notFound('Staff member not found');
    if (body.service_ids.length) {
      const valid = await query(
        `SELECT id FROM salon_services WHERE salon_id = $1 AND id = ANY($2::uuid[])`,
        [salonId, body.service_ids],
      );
      if (valid.length !== body.service_ids.length) throw badRequest('INVALID_SERVICE', 'Unknown service for this salon');
    }

    await query(`DELETE FROM staff_service_mapping WHERE staff_id = $1`, [id]);
    for (const serviceId of body.service_ids) {
      await query(`INSERT INTO staff_service_mapping (staff_id, salon_service_id) VALUES ($1,$2)`, [id, serviceId]);
    }
    return { ok: true, mapped: body.service_ids.length };
  });

  app.get('/partner/resources', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const resources = await query(`SELECT * FROM salon_resources WHERE salon_id = $1 ORDER BY name`, [salonId]);
    return { resources };
  });

  app.post('/partner/resources', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const body = parse(
      z.object({ name: z.string().min(1).max(100), resource_type: z.string().min(1).max(50) }),
      req.body,
    );
    return one(
      `INSERT INTO salon_resources (salon_id, name, resource_type) VALUES ($1,$2,$3) RETURNING *`,
      [salonId, body.name, body.resource_type],
    );
  });

  // ---------- Bookings & calendar ----------
  app.get('/partner/bookings', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const q = parse(
      z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), status: z.string().optional() }),
      req.query,
    );
    const date = q.date ?? fmtLocalDate(new Date());
    const bookings = await query(
      `SELECT b.*, u.full_name AS customer_name, u.phone_blind_index,
              COALESCE(json_agg(json_build_object(
                'id', bi.id, 'service_name', bi.service_name_snapshot, 'staff_id', bi.staff_id,
                'staff_name', sm.display_name, 'start_at', lower(bi.time_range), 'end_at', upper(bi.time_range),
                'price_paise', bi.unit_price_paise, 'status', bi.status
              )) FILTER (WHERE bi.id IS NOT NULL), '[]') AS items
         FROM bookings b
         JOIN users u ON u.id = b.customer_id
         LEFT JOIN booking_items bi ON bi.booking_id = b.id
         LEFT JOIN staff_members sm ON sm.id = bi.staff_id
        WHERE b.salon_id = $1
          AND b.scheduled_start_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND b.scheduled_start_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND ($3::text IS NULL OR b.status::text = $3)
        GROUP BY b.id, u.full_name, u.phone_blind_index
        ORDER BY b.scheduled_start_at`,
      [salonId, date, q.status ?? null],
    );
    return { date, bookings };
  });

  app.get('/partner/bookings/:id', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { id } = req.params as { id: string };
    const booking = await one(`SELECT * FROM bookings WHERE id = $1 AND salon_id = $2`, [id, salonId]);
    if (!booking) throw notFound('Booking not found');
    const items = await query(
      `SELECT bi.*, sm.display_name AS staff_name
         FROM booking_items bi LEFT JOIN staff_members sm ON sm.id = bi.staff_id
        WHERE bi.booking_id = $1 ORDER BY bi.time_range`,
      [id],
    );
    const customer = await one(`SELECT id, full_name, email FROM users WHERE id = $1`, [booking.customer_id]);
    const audit = await query(
      `SELECT * FROM booking_audit_logs WHERE booking_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    return { ...booking, items, customer, audit };
  });

  // ---------- Dashboard ----------
  app.get('/partner/dashboard', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const q = parse(z.object({ period: z.enum(['TODAY', 'WEEK', 'MONTH']).optional() }), req.query);
    return dashboard(salonId, q.period ?? 'TODAY');
  });

  // ---------- Billing ----------
  app.post('/partner/invoices', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key header');
    }
    const body = parse(
      z.object({
        booking_id: z.string().uuid().optional(),
        walkin_token_id: z.string().uuid().optional(),
        discount_paise: z.number().int().min(0).optional(),
        redeem_loyalty_points: z.number().int().min(0).optional(),
        method: z.enum(['CASH', 'UPI_QR', 'ONLINE_UPI', 'CARD', 'LOYALTY_REDEEM', 'PREPAID_WALLET', 'SPLIT']),
      }),
      req.body,
    );
    return createInvoice({
      salonId,
      actor: req.auth!,
      bookingId: body.booking_id,
      walkinTokenId: body.walkin_token_id,
      discountPaise: body.discount_paise,
      redeemLoyaltyPoints: body.redeem_loyalty_points,
      method: body.method,
      idempotencyKey: key,
    });
  });

  app.get('/partner/invoices', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const invoices = await query(
      `SELECT i.*, u.full_name AS customer_name
         FROM invoices_and_payments i JOIN users u ON u.id = i.customer_id
        WHERE i.salon_id = $1 ORDER BY i.created_at DESC LIMIT 100`,
      [salonId],
    );
    const totals = await one(
      `SELECT COALESCE(SUM(net_collected_paise),0)::bigint AS net,
              COALESCE(SUM(platform_commission_paise),0)::bigint AS commission,
              COALESCE(SUM(partner_net_settlement_paise),0)::bigint AS settlement
         FROM invoices_and_payments WHERE salon_id = $1`,
      [salonId],
    );
    return { totals, invoices };
  });

  app.get('/partner/ledger/:customerId', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { customerId } = req.params as { customerId: string };
    const entries = await query(
      `SELECT * FROM customer_value_ledger
        WHERE salon_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 200`,
      [salonId, customerId],
    );
    return { entries };
  });

  // ---------- CRM (tenant-isolated) ----------
  app.get('/partner/crm', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const q = parse(
      z.object({ segment: z.enum(['NEW', 'REGULAR', 'AT_RISK', 'INACTIVE']).optional(), q: z.string().optional() }),
      req.query,
    );
    const rows = await withTenant(salonId, (client) =>
      client.query(
        `SELECT c.*, u.full_name AS customer_name
           FROM salon_customer_crm c JOIN users u ON u.id = c.customer_id
          WHERE c.salon_id = $1
            AND ($2::text IS NULL OR c.retention_segment::text = $2)
            AND ($3::text IS NULL OR u.full_name ILIKE $3)
          ORDER BY c.last_visit_at DESC LIMIT 200`,
        [salonId, q.segment ?? null, q.q ? `%${q.q}%` : null],
      ),
    ).then((r) => r.rows);
    return { customers: rows };
  });

  app.get('/partner/crm/:customerId', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { customerId } = req.params as { customerId: string };
    const crm = await withTenant(salonId, (client) =>
      client.query(
        `SELECT c.*, u.full_name AS customer_name, u.email
           FROM salon_customer_crm c JOIN users u ON u.id = c.customer_id
          WHERE c.salon_id = $1 AND c.customer_id = $2`,
        [salonId, customerId],
      ),
    ).then((r) => r.rows[0]);
    if (!crm) throw notFound('Customer not found in this salon CRM');
    const visits = await query(
      `SELECT id, booking_code, status, scheduled_start_at, total_payable_paise
         FROM bookings WHERE salon_id = $1 AND customer_id = $2 ORDER BY scheduled_start_at DESC LIMIT 20`,
      [salonId, customerId],
    );
    const ledger = await query(
      `SELECT * FROM customer_value_ledger WHERE salon_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [salonId, customerId],
    );
    return { crm, visits, ledger };
  });

  app.patch('/partner/crm/:customerId', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { customerId } = req.params as { customerId: string };
    const body = parse(
      z.object({
        preferred_staff_id: z.string().uuid().nullish(),
        preferred_service_ids: z.array(z.string().uuid()).optional(),
        style_preferences_json: z.record(z.any()).optional(),
        reference_photo_s3_keys: z.array(z.string()).optional(),
        retention_segment: z.enum(['NEW', 'REGULAR', 'AT_RISK', 'INACTIVE']).optional(),
        custom_customer_code: z.string().max(32).optional(),
      }),
      req.body,
    );

    const map: [string, unknown][] = [
      ['preferred_staff_id', body.preferred_staff_id],
      ['preferred_service_ids', body.preferred_service_ids],
      ['style_preferences_json', body.style_preferences_json ? JSON.stringify(body.style_preferences_json) : undefined],
      ['reference_photo_s3_keys', body.reference_photo_s3_keys],
      ['retention_segment', body.retention_segment],
      ['custom_customer_code', body.custom_customer_code],
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [col, value] of map) {
      if (value !== undefined) {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) throw badRequest('VALIDATION_ERROR', 'No fields to update');
    params.push(salonId, customerId);

    const row = await withTenant(salonId, (client) =>
      client.query(
        `UPDATE salon_customer_crm SET ${sets.join(', ')}
          WHERE salon_id = $${params.length - 1} AND customer_id = $${params.length} RETURNING *`,
        params,
      ),
    ).then((r) => r.rows[0]);
    if (!row) throw notFound('Customer not found in this salon CRM');
    return row;
  });

  // ---------- Retention reminders ----------
  app.get('/partner/reminders', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const q = parse(z.object({ status: z.string().optional(), from: z.string().optional() }), req.query);
    return listReminders(salonId, {
      status: q.status ? q.status.split(',') : undefined,
      from: q.from,
    });
  });

  app.post('/partner/reminders/trigger', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const body = parse(
      z.object({
        customer_ids: z.array(z.string().uuid()).min(1).max(200),
        channel: z.enum(['WHATSAPP', 'SMS', 'PUSH', 'EMAIL']).default('WHATSAPP'),
        template_code: z.string().min(2).max(64),
        service_category_id: z.string().uuid().optional(),
      }),
      req.body,
    );
    return triggerReminders({
      salonId,
      customerIds: body.customer_ids,
      channel: body.channel ?? 'WHATSAPP',
      templateCode: body.template_code,
      serviceCategoryId: body.service_category_id,
    });
  });

  // ---------- Walk-in queue ----------
  app.get('/partner/queue', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    return liveQueue(salonId);
  });

  app.patch('/partner/queue/:tokenId', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { tokenId } = req.params as { tokenId: string };
    const body = parse(
      z.object({
        status: z.enum(['WAITING', 'CALLED', 'IN_SERVICE', 'COMPLETED', 'SKIPPED', 'LEFT_QUEUE']),
        assigned_staff_id: z.string().uuid().optional(),
        assigned_resource_id: z.string().uuid().optional(),
      }),
      req.body,
    );
    return updateQueueStatus({
      salonId,
      tokenId,
      status: body.status,
      assignedStaffId: body.assigned_staff_id,
      assignedResourceId: body.assigned_resource_id,
    });
  });

  // ---------- Reviews ----------
  app.get('/partner/reviews', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const reviews = await query(
      `SELECT r.*, u.full_name AS customer_name, sm.display_name AS staff_name
         FROM reviews r
         JOIN users u ON u.id = r.customer_id
         LEFT JOIN staff_members sm ON sm.id = r.staff_id
        WHERE r.salon_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
      [salonId],
    );
    const openAlerts = reviews.filter((r) => r.resolution_status === 'OPEN_ALERT').length;
    return { open_alerts: openAlerts, reviews };
  });

  app.post('/partner/reviews/:id/reply', { preHandler: [authenticate, requireRole(...PARTNER_ROLES)] }, async (req) => {
    const salonId = await resolveSalonId(req);
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({ owner_reply: z.string().min(1).max(2000), resolution_status: z.string().max(32).optional() }),
      req.body,
    );
    const row = await one(
      `UPDATE reviews SET owner_reply = $3, resolution_status = COALESCE($4, resolution_status)
        WHERE id = $1 AND salon_id = $2 RETURNING *`,
      [id, salonId, body.owner_reply, body.resolution_status ?? null],
    );
    if (!row) throw notFound('Review not found');
    return row;
  });
};
