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

  app.get('/discovery/search', async (req) => {
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
  });

  app.get('/discovery/urgent', async (req) => {
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
  });

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

  app.get('/salons/:id', async (req) => {
    const { id } = req.params as { id: string };
    const profile = await salonProfile(id);
    if (!profile.is_active || profile.verification_status !== 'APPROVED') {
      throw notFound('Salon not found');
    }
    return profile;
  });

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

  app.get('/salons/:id/queue', async (req) => {
    const { id } = req.params as { id: string };
    const { liveQueue } = await import('../services/queue.js');
    return liveQueue(id);
  });
};
