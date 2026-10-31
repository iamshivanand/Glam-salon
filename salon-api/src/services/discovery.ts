import { one, query } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { computeAvailability, nextAvailableSlot, fmtLocalDate } from './availability.js';

const IST_TZ = 'Asia/Kolkata';

export interface SearchInput {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  q?: string;
  categoryId?: string;
  openNow?: boolean;
  priceTier?: number[];
  minRating?: number;
  sort?: 'distance' | 'rating' | 'price';
  page: number;
  pageSize: number;
}

function hygieneBadges(row: any): string[] {
  const badges: string[] = [];
  if (row.has_private_room) badges.push('PRIVATE_ROOM');
  if (row.has_women_only_zone) badges.push('WOMEN_ONLY_ZONE');
  if (row.wheelchair_accessible) badges.push('WHEELCHAIR_ACCESSIBLE');
  if (row.uses_disposable_kits) badges.push('DISPOSABLE_KITS');
  if (row.autoclave_sterilization) badges.push('AUTOCLAVE_STERILIZED');
  if (row.parking_available) badges.push('PARKING');
  return badges;
}

export async function searchSalons(input: SearchInput) {
  const params: unknown[] = [];
  const where: string[] = [`s.is_active = TRUE`, `s.verification_status = 'APPROVED'`];

  let distanceExpr = 'NULL::double precision';
  if (typeof input.lat === 'number' && typeof input.lng === 'number') {
    params.push(input.lng, input.lat);
    const lngIdx = params.length - 1;
    const latIdx = params.length;
    distanceExpr = `ST_Distance(s.geo_point, ST_SetSRID(ST_MakePoint($${lngIdx}, $${latIdx}), 4326)::geography) / 1000.0`;
    const radiusKm = input.radiusKm ?? 5;
    params.push(radiusKm * 1000);
    where.push(
      `ST_DWithin(s.geo_point, ST_SetSRID(ST_MakePoint($${lngIdx}, $${latIdx}), 4326)::geography, $${params.length})`,
    );
  }

  if (input.q) {
    params.push(`%${input.q}%`);
    const idx = params.length;
    where.push(`(
      s.name ILIKE $${idx}
      OR EXISTS (SELECT 1 FROM salon_services ss WHERE ss.salon_id = s.id AND ss.is_active AND ss.custom_name ILIKE $${idx})
      OR EXISTS (SELECT 1 FROM staff_members sm WHERE sm.salon_id = s.id AND sm.is_active AND sm.display_name ILIKE $${idx})
    )`);
  }
  if (input.categoryId) {
    params.push(input.categoryId);
    where.push(
      `EXISTS (SELECT 1 FROM salon_services ss WHERE ss.salon_id = s.id AND ss.is_active AND ss.category_id = $${params.length})`,
    );
  }
  if (input.minRating) {
    params.push(input.minRating);
    where.push(`s.avg_rating >= $${params.length}`);
  }
  if (input.priceTier?.length) {
    params.push(input.priceTier);
    where.push(`s.price_tier = ANY($${params.length}::smallint[])`);
  }
  if (input.openNow) {
    where.push(`EXISTS (
      SELECT 1 FROM jsonb_each(s.operating_hours) e
       WHERE lower(e.key) = lower(to_char(NOW() AT TIME ZONE '${IST_TZ}', 'Dy'))
         AND (e.value->>'open') <= to_char(NOW() AT TIME ZONE '${IST_TZ}', 'HH24:MI')
         AND (e.value->>'close') > to_char(NOW() AT TIME ZONE '${IST_TZ}', 'HH24:MI')
    )`);
  }

  const order =
    input.sort === 'rating'
      ? 's.avg_rating DESC, s.review_count DESC'
      : input.sort === 'price'
        ? 'starting_price_paise ASC NULLS LAST'
        : distanceExpr !== 'NULL::double precision'
          ? 'distance_km ASC NULLS LAST'
          : 's.avg_rating DESC';

  params.push(input.pageSize, (input.page - 1) * input.pageSize);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const rows = await query(
    `SELECT s.*, h.has_private_room, h.has_women_only_zone, h.wheelchair_accessible,
            h.uses_disposable_kits, h.autoclave_sterilization, h.parking_available,
            ${distanceExpr} AS distance_km,
            (SELECT MIN(COALESCE(ss.discounted_price_paise, ss.base_price_paise))
               FROM salon_services ss WHERE ss.salon_id = s.id AND ss.is_active) AS starting_price_paise
       FROM salons s
       LEFT JOIN salon_hygiene_facilities h ON h.salon_id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );

  const total = await one<{ total: string }>(
    `SELECT COUNT(*)::int AS total FROM salons s WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2),
  );

  const queueRows = await query(
    `SELECT salon_id,
            COUNT(*) FILTER (WHERE status = 'WAITING')::int AS waiting_count,
            COALESCE(MIN(estimated_wait_mins) FILTER (WHERE status = 'WAITING'), 0)::int AS estimated_wait_mins
       FROM walkin_queue_tokens
      WHERE queue_date = $1
      GROUP BY salon_id`,
    [fmtLocalDate(new Date())],
  );
  const queueBySalon = new Map(queueRows.map((r) => [r.salon_id, r]));

  const salons = [];
  for (const row of rows) {
    const q = queueBySalon.get(row.id);
    salons.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      salon_type: row.salon_type,
      address_line: row.address_line,
      locality: row.locality,
      city: row.city,
      distance_km: row.distance_km != null ? Number(Number(row.distance_km).toFixed(2)) : null,
      avg_rating: Number(row.avg_rating),
      review_count: row.review_count,
      is_sponsored: row.is_sponsored,
      hygiene_badges: hygieneBadges(row),
      starting_price_paise: row.starting_price_paise ?? null,
      next_available_slot: await nextAvailableSlot(row.id),
      live_queue: {
        waiting_count: q?.waiting_count ?? 0,
        estimated_wait_mins: q?.estimated_wait_mins ?? 0,
      },
    });
  }

  return { meta: { total: Number(total?.total ?? 0), page: input.page, page_size: input.pageSize }, salons };
}

export async function compareSalons(salonIds: string[], categoryId: string) {
  if (!salonIds.length) throw badRequest('VALIDATION_ERROR', 'salon_ids is required');
  const category = await one(`SELECT * FROM service_categories WHERE id = $1`, [categoryId]);
  if (!category) throw notFound('Category not found');

  const comparison = [];
  for (const salonId of salonIds.slice(0, 4)) {
    const salon = await one(`SELECT * FROM salons WHERE id = $1`, [salonId]);
    if (!salon) continue;
    const service = await one(
      `SELECT * FROM salon_services
        WHERE salon_id = $1 AND category_id = $2 AND is_active = TRUE
        ORDER BY COALESCE(discounted_price_paise, base_price_paise) ASC LIMIT 1`,
      [salonId, categoryId],
    );
    const facilities = await one(`SELECT * FROM salon_hygiene_facilities WHERE salon_id = $1`, [salonId]);
    const slot = await nextAvailableSlot(salonId);
    comparison.push({
      salon_id: salon.id,
      salon_name: salon.name,
      service_name: service?.custom_name ?? null,
      price_paise: service ? (service.discounted_price_paise ?? service.base_price_paise) : null,
      pricing_model: service?.pricing_model ?? null,
      duration_mins: service?.duration_mins ?? null,
      facilities: facilities
        ? {
            has_private_room: facilities.has_private_room,
            uses_disposable_kits: facilities.uses_disposable_kits,
            autoclave_sterilization: facilities.autoclave_sterilization,
            wheelchair_accessible: facilities.wheelchair_accessible,
            has_women_only_zone: facilities.has_women_only_zone,
          }
        : null,
      next_slot: slot ? slot.slice(11, 16) : null,
      queue_wait_mins: 0,
    });
  }
  return { category: category.name, comparison };
}

export async function urgentSlots(input: {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  categoryId?: string;
  withinMins?: number;
}) {
  const within = input.withinMins ?? 120;
  const now = Date.now();
  const deadline = now + within * 60_000;

  const params: unknown[] = [];
  const where = [`s.is_active = TRUE`, `s.verification_status = 'APPROVED'`];
  if (typeof input.lat === 'number' && typeof input.lng === 'number') {
    params.push(input.lng, input.lat);
    const lngIdx = params.length - 1;
    const latIdx = params.length;
    params.push((input.radiusKm ?? 5) * 1000);
    where.push(
      `ST_DWithin(s.geo_point, ST_SetSRID(ST_MakePoint($${lngIdx}, $${latIdx}), 4326)::geography, $${params.length})`,
    );
  }
  if (input.categoryId) {
    params.push(input.categoryId);
    where.push(
      `EXISTS (SELECT 1 FROM salon_services ss WHERE ss.salon_id = s.id AND ss.is_active AND ss.category_id = $${params.length})`,
    );
  }

  const salons = await query(`SELECT s.* FROM salons s WHERE ${where.join(' AND ')} LIMIT 50`, params);
  const matches = [];

  for (const salon of salons) {
    const service = await one<{ id: string; custom_name: string; base_price_paise: number; discounted_price_paise: number | null }>(
      `SELECT id, custom_name, base_price_paise, discounted_price_paise
         FROM salon_services
        WHERE salon_id = $1 AND is_active = TRUE
          AND ($2::uuid IS NULL OR category_id = $2)
        ORDER BY duration_mins ASC LIMIT 1`,
      [salon.id, input.categoryId ?? null],
    );
    if (!service) continue;

    for (const offset of [0, 1]) {
      const dateISO = fmtLocalDate(new Date(now + offset * 86_400_000));
      const availability = await computeAvailability({ salonId: salon.id, serviceIds: [service.id], dateISO });
      const slot = availability.slots.find((s) => {
        const t = new Date(s.start_at).getTime();
        return t >= now && t <= deadline;
      });
      if (slot) {
        matches.push({
          salon_id: salon.id,
          salon_name: salon.name,
          distance_km: null,
          travel_eta_mins: 10,
          earliest_slot_start: slot.start_at,
          starts_in_mins: Math.max(0, Math.round((new Date(slot.start_at).getTime() - now) / 60_000)),
          staff_id: slot.staff_id,
          staff_name: null,
          price_paise: service.discounted_price_paise ?? service.base_price_paise,
          flash_deal_discount_paise: 0,
          instant_confirm_guaranteed: slot.instant_confirm,
        });
        break;
      }
    }
  }

  matches.sort((a, b) => a.starts_in_mins - b.starts_in_mins);
  return { urgent_matches: matches.slice(0, 20) };
}

export async function salonProfile(salonId: string): Promise<Record<string, any>> {
  const salon = await one(`SELECT * FROM salons WHERE id = $1`, [salonId]);
  if (!salon) throw notFound('Salon not found');
  const facilities = await one(`SELECT * FROM salon_hygiene_facilities WHERE salon_id = $1`, [salonId]);
  const services = await query(
    `SELECT ss.*, sc.name AS category_name, sc.slug AS category_slug
       FROM salon_services ss
       JOIN service_categories sc ON sc.id = ss.category_id
      WHERE ss.salon_id = $1 AND ss.is_active = TRUE
      ORDER BY sc.display_order, ss.custom_name`,
    [salonId],
  );
  const staff = await query(
    `SELECT id, display_name, specialization, experience_years, is_bgv_verified,
            avg_rating, review_count, home_visit_enabled
       FROM staff_members WHERE salon_id = $1 AND is_active = TRUE ORDER BY display_name`,
    [salonId],
  );
  const reviews = await query(
    `SELECT r.id, r.overall_rating, r.hygiene_rating, r.review_text, r.created_at,
            u.full_name AS customer_name, sm.display_name AS staff_name
       FROM reviews r
       JOIN users u ON u.id = r.customer_id
       LEFT JOIN staff_members sm ON sm.id = r.staff_id
      WHERE r.salon_id = $1 AND r.is_published = TRUE
      ORDER BY r.created_at DESC LIMIT 10`,
    [salonId],
  );

  return {
    ...salon,
    hygiene_facilities: facilities ?? null,
    services,
    staff,
    reviews,
  };
}
