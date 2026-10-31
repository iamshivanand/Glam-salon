import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db.js';
import { parse, badRequest, notFound } from '../http.js';
import { authenticate, requireRole } from '../auth.js';

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

  app.post('/admin/kyc/:salonId/review', async (req) => {
    const { salonId } = req.params as { salonId: string };
    const body = parse(
      z.object({
        decision: z.enum(['APPROVED', 'REJECTED', 'UNDER_REVIEW']),
        rejection_reason: z.string().max(500).optional(),
      }),
      req.body,
    );
    if (body.decision === 'REJECTED' && !body.rejection_reason) {
      throw badRequest('VALIDATION_ERROR', 'rejection_reason is required when rejecting');
    }

    const kyc = await one(
      `UPDATE salon_kyc_verifications
          SET status = $2, rejection_reason = $3, reviewed_by_admin_id = $4, reviewed_at = NOW()
        WHERE salon_id = $1 RETURNING *`,
      [salonId, body.decision, body.rejection_reason ?? null, req.auth!.id],
    );
    if (!kyc) throw notFound('KYC submission not found');

    await query(`UPDATE salons SET verification_status = $2 WHERE id = $1`, [salonId, body.decision]);
    return { salon_id: salonId, verification_status: body.decision };
  });

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
              s.avg_rating, s.review_count, u.full_name AS owner_name, s.created_at
         FROM salons s JOIN users u ON u.id = s.owner_id
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
};
