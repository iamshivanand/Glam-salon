import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parse } from '../http.js';
import { authenticate, requireRole } from '../auth.js';
import { blindIndex, encrypt } from '../crypto.js';
import { joinQueue, liveQueue, updateQueueStatus } from '../services/queue.js';

const JoinInput = z.object({
  salon_id: z.string().uuid(),
  customer_name: z.string().min(1).max(100).optional(),
  phone: z.string().min(8).max(20).optional(),
  service_ids: z.array(z.string().uuid()).min(1).max(10),
  preferred_staff_id: z.string().uuid().optional(),
});

export const queueRoutes: FastifyPluginAsync = async (app) => {
  app.post('/queue/join', async (req) => {
    const body = parse(JoinInput, req.body);
    let customerId: string | null = null;
    let phoneEncrypted: Buffer | null = null;
    let phoneIndex: string | null = null;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      await authenticate(req);
      customerId = req.auth!.id;
    }
    if (body.phone) {
      const normalized = body.phone.replace(/[^\d+]/g, '');
      phoneEncrypted = encrypt(normalized);
      phoneIndex = blindIndex(normalized);
    }
    if (!customerId && !body.customer_name) {
      const { badRequest } = await import('../http.js');
      throw badRequest('VALIDATION_ERROR', 'customer_name is required for guest walk-ins');
    }

    return joinQueue({
      salonId: body.salon_id,
      customerId,
      customerName: body.customer_name ?? 'Guest',
      phoneEncrypted,
      phoneBlindIndex: phoneIndex,
      serviceIds: body.service_ids,
      preferredStaffId: body.preferred_staff_id,
    });
  });

  app.get('/queue/:salonId/live', async (req) => {
    const { salonId } = req.params as { salonId: string };
    return liveQueue(salonId);
  });

  app.patch(
    '/queue/:salonId/tokens/:tokenId',
    { preHandler: [authenticate, requireRole('SALON_OWNER', 'SALON_MANAGER', 'STAFF', 'PLATFORM_ADMIN')] },
    async (req) => {
      const { salonId, tokenId } = req.params as { salonId: string; tokenId: string };
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
    },
  );
};
