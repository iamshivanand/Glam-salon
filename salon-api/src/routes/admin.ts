import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db.js';
import { parse, badRequest, notFound, conflict } from '../http.js';
import { authenticate, requireRole, revokeAllRefreshForUser } from '../auth.js';
import { listAudit, recordAudit } from '../services/audit.js';
import { recordPayout } from '../services/payments.js';

const AccountStatus = z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']);
const UserRole = z.enum(['CUSTOMER', 'SALON_OWNER', 'SALON_MANAGER', 'STAFF', 'PLATFORM_ADMIN']);

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
    await recordAudit({
      actorId: req.auth!.id,
      actorRole: req.auth!.role,
      salonId,
      action: 'kyc.reviewed',
      entityType: 'salon_kyc_verification',
      entityId: salonId,
      metadata: { decision: body.decision, rejection_reason: body.rejection_reason ?? null },
      ip: req.ip,
    });
    return { salon_id: salonId, verification_status: body.decision };
  });

  app.patch('/admin/salons/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        is_active: z.boolean(),
        reason: z.string().max(500).optional(),
      }),
      req.body,
    );
    const row = await one(
      `UPDATE salons SET is_active = $2 WHERE id = $1
       RETURNING id, name, is_active, verification_status`,
      [id, body.is_active],
    );
    if (!row) throw notFound('Salon not found');
    await recordAudit({
      actorId: req.auth!.id,
      actorRole: req.auth!.role,
      salonId: id,
      action: body.is_active ? 'salon.activated' : 'salon.deactivated',
      entityType: 'salon',
      entityId: id,
      metadata: { reason: body.reason ?? null },
      ip: req.ip,
    });
    return row;
  });

  app.patch('/admin/users/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        status: AccountStatus.optional(),
        role: UserRole.optional(),
        reason: z.string().max(500).optional(),
      }),
      req.body,
    );
    if (!body.status && !body.role) throw badRequest('VALIDATION_ERROR', 'Set status or role');
    if (id === req.auth!.id) {
      throw badRequest('SELF_MODIFICATION', 'You cannot change your own role or status');
    }

    const before = await one<{ id: string; role: string; status: string }>(
      `SELECT id, role, status FROM users WHERE id = $1`,
      [id],
    );
    if (!before) throw notFound('User not found');

    if (body.role === 'PLATFORM_ADMIN' || before.role === 'PLATFORM_ADMIN') {
      const admins = await one<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users
          WHERE role = 'PLATFORM_ADMIN' AND status = 'ACTIVE'`,
      );
      if (before.role === 'PLATFORM_ADMIN' && Number(admins?.count ?? 0) <= 1) {
        throw conflict('LAST_ADMIN', 'At least one active platform admin must remain');
      }
    }

    const updated = await one(
      `UPDATE users
          SET role = COALESCE($2, role),
              status = COALESCE($3, status),
              deleted_at = CASE
                WHEN $3 = 'DELETED' THEN COALESCE(deleted_at, NOW())
                WHEN $3 = 'ACTIVE' THEN NULL
                ELSE deleted_at
              END
        WHERE id = $1
        RETURNING id, full_name, email, role, status, deleted_at`,
      [id, body.role ?? null, body.status ?? null],
    );

    if (body.status && body.status !== 'ACTIVE') {
      await revokeAllRefreshForUser(id);
    }
    await recordAudit({
      actorId: req.auth!.id,
      actorRole: req.auth!.role,
      action: 'user.updated',
      entityType: 'user',
      entityId: id,
      metadata: {
        before: { role: before.role, status: before.status },
        after: { role: updated?.role, status: updated?.status },
        reason: body.reason ?? null,
      },
      ip: req.ip,
    });
    return updated;
  });

  app.post('/admin/salons/:id/payouts', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        amount_paise: z.number().int().positive(),
        reference: z.string().max(128).optional(),
        notes: z.string().max(500).optional(),
      }),
      req.body,
    );
    if (body.period_end < body.period_start) {
      throw badRequest('VALIDATION_ERROR', 'period_end must be on or after period_start');
    }
    const salon = await one(`SELECT id FROM salons WHERE id = $1`, [id]);
    if (!salon) throw notFound('Salon not found');
    return recordPayout({
      salonId: id,
      periodStart: body.period_start,
      periodEnd: body.period_end,
      amountPaise: body.amount_paise,
      reference: body.reference,
      notes: body.notes,
      recordedBy: req.auth!.id,
      actorRole: req.auth!.role,
      ip: req.ip,
    });
  });

  app.get('/admin/audit', async (req) => {
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        action: z.string().max(64).optional(),
        salon_id: z.string().uuid().optional(),
      }),
      req.query,
    );
    return {
      events: await listAudit({
        limit: q.limit ?? 100,
        action: q.action,
        salonId: q.salon_id,
      }),
    };
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
    await recordAudit({
      actorId: req.auth!.id,
      actorRole: req.auth!.role,
      salonId: id,
      action: 'commission.updated',
      entityType: 'salon_commission_config',
      entityId: id,
      metadata: {
        plan_tier: body.plan_tier ?? null,
        marketplace_new_client_bps: body.marketplace_new_client_bps ?? null,
        repeat_crm_client_bps: body.repeat_crm_client_bps ?? null,
        saas_monthly_fee_paise: body.saas_monthly_fee_paise ?? null,
      },
      ip: req.ip,
    });
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
};
