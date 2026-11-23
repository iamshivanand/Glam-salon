import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db.js';
import { parse, badRequest, notFound } from '../http.js';
import { authenticate, requireRole } from '../auth.js';
import { queueTransactional } from '../services/transactional.js';

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole('PLATFORM_ADMIN'));

  app.get('/admin/stats', async () => {
    const salons = await one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE verification_status = 'APPROVED')::int AS approved,
              COUNT(*) FILTER (WHERE verification_status = 'SUBMITTED')::int AS pending
         FROM salons`,
    );
    const users = await one(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE role = 'CUSTOMER')::int AS customers
         FROM users WHERE status <> 'DELETED'`,
    );
    const gmv = await one(
      `SELECT COALESCE(SUM(net_collected_paise),0)::bigint AS gmv,
              COALESCE(SUM(platform_commission_paise),0)::bigint AS commission
         FROM invoices_and_payments`,
    );
    return { salons, users, gmv };
  });

  app.get('/admin/kyc', async (req) => {
    const q = parse(
      z.object({ status: z.enum(['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED']).optional() }),
      req.query,
    );
    const rows = await query(
      `SELECT k.id, k.salon_id, s.name AS salon_name, s.owner_id, s.verification_status,
              k.gstin, k.bank_ifsc, k.shop_license_s3_key, k.status AS kyc_status,
              k.rejection_reason, k.created_at
         FROM salon_kyc_verifications k
         JOIN salons s ON s.id = k.salon_id
        WHERE ($1::text IS NULL OR k.status::text = $1)
        ORDER BY k.created_at DESC`,
      [q.status ?? null],
    );
    return { submissions: rows };
  });

  const handleKycReview = async (req: any) => {
    const salonId = (req.params as any).salonId ?? (req.params as any).id;
    const body = parse(
      z.object({
        decision: z.enum(['APPROVED', 'REJECTED', 'UNDER_REVIEW']).optional(),
        status: z.enum(['APPROVED', 'REJECTED', 'UNDER_REVIEW']).optional(),
        rejection_reason: z.string().max(500).optional(),
      }),
      req.body,
    );
    const decision = body.decision ?? body.status;
    if (!decision) {
      throw badRequest('VALIDATION_ERROR', 'decision or status is required');
    }
    if (decision === 'REJECTED' && !body.rejection_reason) {
      throw badRequest('VALIDATION_ERROR', 'rejection_reason is required when rejecting');
    }

    const kyc = await one(
      `UPDATE salon_kyc_verifications
          SET status = $2, rejection_reason = $3, reviewed_by_admin_id = $4, reviewed_at = NOW()
        WHERE salon_id = $1 RETURNING *`,
      [salonId, decision, body.rejection_reason ?? null, req.auth!.id],
    );
    if (!kyc) throw notFound('KYC submission not found');

    await query(`UPDATE salons SET verification_status = $2 WHERE id = $1`, [salonId, decision]);

    const salon = await one<{ id: string; name: string; owner_id: string }>(
      `SELECT id, name, owner_id FROM salons WHERE id = $1`,
      [salonId],
    );
    if (salon && (decision === 'APPROVED' || decision === 'REJECTED')) {
      const template = decision === 'APPROVED' ? 'KYC_APPROVED' : 'KYC_REJECTED';
      queueTransactional({
        template,
        userId: salon.owner_id,
        salonId: salon.id,
        context: {
          customerName: 'Partner',
          salonName: salon.name,
          reason: body.rejection_reason,
        },
      });
    }

    return { salon_id: salonId, verification_status: decision };
  };

  app.post('/admin/kyc/:salonId/review', handleKycReview);
  app.post('/admin/salons/:id/verify', handleKycReview);

  app.patch('/admin/salons/:id/commission', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        plan_tier: z.enum(['STANDARD_COMMISSION', 'SAAS_FLAT_FEE', 'HYBRID']).optional(),
        marketplace_new_client_bps: z.number().int().min(0).max(10000).optional(),
        repeat_crm_client_bps: z.number().int().min(0).max(10000).optional(),
        saas_monthly_fee_paise: z.number().int().min(0).optional(),
      }),
      req.body,
    );
    const row = await one(
      `INSERT INTO salon_commission_configs
         (salon_id, plan_tier, marketplace_new_client_bps, repeat_crm_client_bps, saas_monthly_fee_paise)
       VALUES ($1, COALESCE($2,'STANDARD_COMMISSION'), COALESCE($3,1500), COALESCE($4,0), COALESCE($5,0))
       ON CONFLICT (salon_id) DO UPDATE SET
         plan_tier = COALESCE($2, salon_commission_configs.plan_tier),
         marketplace_new_client_bps = COALESCE($3, salon_commission_configs.marketplace_new_client_bps),
         repeat_crm_client_bps = COALESCE($4, salon_commission_configs.repeat_crm_client_bps),
         saas_monthly_fee_paise = COALESCE($5, salon_commission_configs.saas_monthly_fee_paise)
       RETURNING *`,
      [
        id,
        body.plan_tier ?? null,
        body.marketplace_new_client_bps ?? null,
        body.repeat_crm_client_bps ?? null,
        body.saas_monthly_fee_paise ?? null,
      ],
    );
    return row;
  });

  app.get('/admin/salons', async (req) => {
    const q = parse(z.object({ status: z.string().optional() }), req.query);
    const rows = await query(
      `SELECT s.id, s.name, s.city, s.locality, s.verification_status, s.is_active,
              s.avg_rating, s.review_count, u.full_name AS owner_name, s.created_at,
              c.plan_tier,
              c.marketplace_new_client_bps,
              c.repeat_crm_client_bps
         FROM salons s
         JOIN users u ON u.id = s.owner_id
         LEFT JOIN salon_commission_configs c ON c.salon_id = s.id
        WHERE ($1::text IS NULL OR s.verification_status::text = $1)
        ORDER BY s.created_at DESC`,
      [q.status ?? null],
    );
    return { salons: rows };
  });

  app.get('/admin/users', async (req) => {
    const q = parse(z.object({ role: z.string().optional(), q: z.string().optional() }), req.query);
    const rows = await query(
      `SELECT id, full_name, email, role, status, last_login_at, created_at
         FROM users
        WHERE ($1::text IS NULL OR role::text = $1)
          AND ($2::text IS NULL OR full_name ILIKE $2)
        ORDER BY created_at DESC LIMIT 200`,
      [q.role ?? null, q.q ? `%${q.q}%` : null],
    );
    return { users: rows };
  });

  // API-38: Platform admin disputes listing & escalation management
  app.get('/admin/disputes', async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['OPEN_ALERT', 'ESCALATED', 'RESOLVED', 'ALL']).optional(),
      }),
      req.query,
    );
    const filterStatus = q.status ?? null;
    const rows = await query(
      `SELECT r.id, r.booking_id, b.booking_code,
              r.salon_id, s.name AS salon_name, s.locality AS salon_locality, s.city AS salon_city,
              r.customer_id, u.full_name AS customer_name,
              r.staff_id, sm.display_name AS staff_name,
              r.overall_rating, r.hygiene_rating, r.review_text,
              COALESCE(r.ai_complaint_tags, '{}') AS ai_complaint_tags,
              r.owner_reply, r.resolution_status,
              r.created_at
         FROM reviews r
         JOIN salons s ON s.id = r.salon_id
         JOIN bookings b ON b.id = r.booking_id
         JOIN users u ON u.id = r.customer_id
         LEFT JOIN staff_members sm ON sm.id = r.staff_id
        WHERE ($1::text IS NULL AND r.resolution_status IN ('OPEN_ALERT', 'ESCALATED'))
           OR ($1::text = 'ALL')
           OR ($1::text IS NOT NULL AND r.resolution_status::text = $1)
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [filterStatus],
    );
    return { disputes: rows };
  });

  app.patch('/admin/disputes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        resolution_status: z.enum(['OPEN_ALERT', 'ESCALATED', 'RESOLVED']),
        owner_reply: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const updated = await one(
      `UPDATE reviews
          SET resolution_status = $2,
              owner_reply = COALESCE($3, owner_reply)
        WHERE id = $1
        RETURNING *`,
      [id, body.resolution_status, body.owner_reply ?? null],
    );
    if (!updated) throw notFound('Review not found');
    return updated;
  });
};
