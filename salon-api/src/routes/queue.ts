import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parse, badRequest, forbidden } from '../http.js';
import { authenticate } from '../auth.js';
import { blindIndex, encrypt } from '../crypto.js';
import { joinQueue, liveQueue, updateQueueStatus, getTokenStatus } from '../services/queue.js';
import { redis } from '../redis.js';

const JoinInput = z.object({
  salon_id: z.string().uuid(),
  customer_name: z.string().min(1).max(100).optional(),
  phone: z.string().min(8).max(20).optional(),
  service_ids: z.array(z.string().uuid()).min(1).max(10),
  preferred_staff_id: z.string().uuid().optional(),
});

const UpdateTokenInput = z.object({
  status: z.enum(['WAITING', 'CALLED', 'IN_SERVICE', 'COMPLETED', 'SKIPPED', 'LEFT_QUEUE']),
  assigned_staff_id: z.string().uuid().optional(),
  assigned_resource_id: z.string().uuid().optional(),
});

export const queueRoutes: FastifyPluginAsync = async (app) => {
  // API-20 – Join walk-in queue
  const handleJoin = async (req: any) => {
    const params = (req.params || {}) as { salonId?: string };
    const rawBody = (req.body || {}) as any;
    const salonId = params.salonId || rawBody.salon_id;
    const body = parse(JoinInput, { ...rawBody, salon_id: salonId });

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
  };

  app.post('/queue/join', handleJoin);
  app.post('/salons/:salonId/queue/join', handleJoin);

  // API-21 – Get live queue (JSON snapshot or SSE real-time stream)
  const handleLiveQueue = async (req: any, reply: any) => {
    const { salonId } = req.params as { salonId: string };
    const acceptsStream =
      req.headers.accept?.includes('text/event-stream') ||
      req.query?.stream === 'true' ||
      req.query?.stream === '1';

    if (acceptsStream) {
      const initial = await liveQueue(salonId);

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('Access-Control-Allow-Origin', '*');
      reply.raw.flushHeaders?.();

      reply.raw.write(`data: ${JSON.stringify(initial)}\n\n`);

      const sub = redis.duplicate();
      await sub.subscribe(`pubsub:queue:${salonId}`);
      sub.on('message', (_channel: string, message: string) => {
        try {
          reply.raw.write(`data: ${message}\n\n`);
        } catch {
          // Socket write failed
        }
      });

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': keep-alive\n\n');
        } catch {
          // Socket write failed
        }
      }, 15000);

      req.raw.on('close', () => {
        clearInterval(heartbeat);
        sub.disconnect();
      });
      return;
    }

    return liveQueue(salonId);
  };

  app.get('/queue/:salonId/live', handleLiveQueue);
  app.get('/salons/:salonId/queue', handleLiveQueue);

  // Individual token tracking
  const handleGetToken = async (req: any) => {
    const { salonId, tokenId } = req.params as { salonId: string; tokenId: string };
    return getTokenStatus(salonId, tokenId);
  };

  app.get('/queue/:salonId/tokens/:tokenId', handleGetToken);
  app.get('/salons/:salonId/queue/tokens/:tokenId', handleGetToken);

  // API-22 – Update queue token status
  const handleUpdateToken = async (req: any) => {
    const { salonId, tokenId } = req.params as { salonId: string; tokenId: string };
    const body = parse(UpdateTokenInput, req.body);

    const partnerRoles = ['SALON_OWNER', 'SALON_MANAGER', 'STAFF', 'PLATFORM_ADMIN'];
    if (!partnerRoles.includes(req.auth!.role)) {
      if (body.status !== 'LEFT_QUEUE') {
        throw forbidden('Only salon staff can update queue status');
      }
    }

    return updateQueueStatus({
      salonId,
      tokenId,
      status: body.status,
      assignedStaffId: body.assigned_staff_id,
      assignedResourceId: body.assigned_resource_id,
    });
  };

  app.patch('/queue/:salonId/tokens/:tokenId', { preHandler: [authenticate] }, handleUpdateToken);
  app.patch('/salons/:salonId/queue/tokens/:tokenId', { preHandler: [authenticate] }, handleUpdateToken);
};
