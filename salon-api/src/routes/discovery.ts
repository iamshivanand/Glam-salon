import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db.js';
import { parse, badRequest, notFound, pagination } from '../http.js';
import { computeAvailability, fmtLocalDate } from '../services/availability.js';
import { compareSalons, salonProfile, searchSalons, urgentSlots } from '../services/discovery.js';

const SearchQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius_km: z.coerce.number().min(0.5).max(50).optional(),
  q: z.string().max(120).optional(),
  category_id: z.string().uuid().optional(),
  open_now: z.enum(['true', 'false']).optional(),
  price_tier: z.string().optional(),
  min_rating: z.coerce.number().min(0).max(5).optional(),
  sort: z.enum(['distance', 'rating', 'price']).optional(),
});

const AvailabilityQuery = z.object({
  service_ids: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  staff_id: z.string().uuid().optional(),
});

export const discoveryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/categories', async () => {
    const categories = await query(
      `SELECT id, parent_id, name, slug, default_reminder_interval_days, display_order
         FROM service_categories WHERE is_active = TRUE ORDER BY display_order, name`,
    );
    return { categories };
  });

  const handleSearch = async (req: any) => {
    const q = parse(SearchQuery, req.query);
    const page = pagination(req.query as Record<string, unknown>);
    const priceTier = q.price_tier
      ? q.price_tier
        .split(',')
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v))
      : undefined;

    return searchSalons({
      lat: q.lat,
      lng: q.lng,
      radiusKm: q.radius_km,
      q: q.q,
      categoryId: q.category_id,
      openNow: q.open_now === 'true',
      priceTier,
      minRating: q.min_rating,
      sort: q.sort,
      page: page.page,
      pageSize: page.pageSize,
    });
  };

  app.get('/discovery/search', handleSearch);
  app.get('/discovery/salons', handleSearch); // API-09 blueprint route alias

  const handleUrgent = async (req: any) => {
    const q = parse(
      z.object({
        lat: z.coerce.number().optional(),
        lng: z.coerce.number().optional(),
        radius_km: z.coerce.number().min(0.5).max(50).optional(),
        category_id: z.string().uuid().optional(),
        within_mins: z.coerce.number().min(15).max(480).optional(),
      }),
      req.query,
    );
    return urgentSlots({
      lat: q.lat,
      lng: q.lng,
      radiusKm: q.radius_km,
      categoryId: q.category_id,
      withinMins: q.within_mins,
    });
  };

  app.get('/discovery/urgent', handleUrgent);
  app.get('/discovery/urgent-slots', handleUrgent); // API-10 blueprint route alias

  app.get('/discovery/compare', async (req) => {
    const q = parse(
      z.object({
        salon_ids: z.string().min(1),
        category_id: z.string().uuid(),
      }),
      req.query,
    );
    const ids = q.salon_ids.split(',').map((s) => s.trim()).filter(Boolean);
    return compareSalons(ids, q.category_id);
  });

  const handleSalonProfile = async (req: any) => {
    const { id } = req.params as { id: string };
    const profile = await salonProfile(id);
    if (!profile.is_active || profile.verification_status !== 'APPROVED') {
      throw notFound('Salon not found');
    }
    return profile;
  };

  app.get('/salons/:id', handleSalonProfile);
  app.get('/salons/:id/profile', handleSalonProfile); // API-12 blueprint route alias

  const handleAddonRecommendations = async (req: any) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const rawIds = q.service_ids ?? q.primary_service_ids ?? q.primary_service_id ?? q.service_id ?? '';
    const selectedIds = rawIds
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
    const staffId = q.staff_id && /^[0-9a-f-]{36}$/i.test(q.staff_id) ? q.staff_id : null;

    const rows = await query(
      `SELECT DISTINCT ON (s.id)
              a.id AS addon_mapping_id,
              a.primary_service_id,
              a.addon_service_id,
              a.bundle_discount_paise,
              a.priority_rank,
              s.id AS service_id,
              s.custom_name AS name,
              s.description,
              s.base_price_paise,
              s.discounted_price_paise,
              GREATEST(0, COALESCE(s.discounted_price_paise, s.base_price_paise) - a.bundle_discount_paise) AS bundle_price_paise,
              s.duration_mins,
              s.buffer_after_mins,
              sc.name AS category_name,
              (CASE WHEN $2::uuid[] IS NOT NULL AND a.primary_service_id = ANY($2::uuid[]) THEN 0 ELSE 1 END) AS match_rank
         FROM salon_service_addons a
         JOIN salon_services s ON s.id = a.addon_service_id
         JOIN service_categories sc ON sc.id = s.category_id
        WHERE a.salon_id = $1
          AND a.is_active = TRUE
          AND s.is_active = TRUE
          AND ($2::uuid[] IS NULL OR NOT (s.id = ANY($2::uuid[])))
          AND ($3::uuid IS NULL OR EXISTS (
            SELECT 1 FROM staff_service_mapping ssm
             WHERE ssm.staff_id = $3
               AND ssm.salon_service_id = s.id
          ) OR NOT EXISTS (
            SELECT 1 FROM staff_service_mapping ssm WHERE ssm.staff_id = $3
          ))
        ORDER BY s.id, match_rank ASC, a.priority_rank ASC, bundle_price_paise ASC
        LIMIT 6`,
      [id, selectedIds.length ? selectedIds : null, staffId],
    );

    rows.sort((a, b) => (a.match_rank - b.match_rank) || (a.priority_rank - b.priority_rank));
    return { addons: rows };
  };

  app.get('/salons/:id/addons/recommend', handleAddonRecommendations); // API-14
  app.get('/salons/:id/addons', handleAddonRecommendations);

  app.get('/salons/:id/availability', async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(AvailabilityQuery, req.query);
    const serviceIds = q.service_ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (!serviceIds.length) throw badRequest('VALIDATION_ERROR', 'service_ids is required');
    return computeAvailability({ salonId: id, serviceIds, dateISO: q.date, staffId: q.staff_id });
  });

  app.get('/salons/:id/availability/next', async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ service_ids: z.string().min(1), staff_id: z.string().uuid().optional() }), req.query);
    const serviceIds = q.service_ids.split(',').map((s) => s.trim()).filter(Boolean);

    for (let i = 0; i < 14; i++) {
      const dateISO = fmtLocalDate(new Date(Date.now() + i * 86_400_000));
      const result = await computeAvailability({ salonId: id, serviceIds, dateISO, staffId: q.staff_id });
      if (result.slots.length) return { date: dateISO, slot: result.slots[0] };
    }
    return { date: null, slot: null };
  });

  app.get('/salons/:id/reviews', async (req) => {
    const { id } = req.params as { id: string };
    const page = pagination(req.query as Record<string, unknown>);
    const reviews = await query(
      `SELECT r.id, r.overall_rating, r.hygiene_rating, r.review_text, r.owner_reply,
              r.created_at, u.full_name AS customer_name, sm.display_name AS staff_name
         FROM reviews r
         JOIN users u ON u.id = r.customer_id
         LEFT JOIN staff_members sm ON sm.id = r.staff_id
        WHERE r.salon_id = $1 AND r.is_published = TRUE
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [id, page.pageSize, page.offset],
    );
    const stats = await one(
      `SELECT COUNT(*)::int AS total,
              COALESCE(ROUND(AVG(overall_rating)::numeric, 2), 0) AS avg_rating,
              COALESCE(ROUND(AVG(hygiene_rating)::numeric, 2), 0) AS avg_hygiene
         FROM reviews WHERE salon_id = $1 AND is_published = TRUE`,
      [id],
    );
    return { stats, reviews };
  });
};
