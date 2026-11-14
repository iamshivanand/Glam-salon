import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one } from '../db.js';
import { parse, AppError, badRequest, forbidden } from '../http.js';
import { authenticate, requireRole } from '../auth.js';
import { buildObjectKey, presignPut, storageConfigured, storageProviderName } from '../services/storage.js';

const PresignInput = z.object({
  purpose: z.enum(['avatar', 'kyc_document', 'style_photo']),
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  salon_id: z.string().uuid().optional(),
});

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.get('/uploads/status', async () => ({
    provider: storageProviderName(),
    configured: storageConfigured(),
    allowed_content_types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    note: 'Presigned uploads write directly to object storage. The API never proxies file bytes.',
  }));

  app.post('/uploads/presign', { preHandler: [authenticate] }, async (req) => {
    const body = parse(PresignInput, req.body);
    if (!storageConfigured()) {
      throw new AppError(
        503,
        'STORAGE_NOT_CONFIGURED',
        'Object storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
      );
    }

    if (body.purpose === 'kyc_document') {
      if (!body.salon_id) throw badRequest('VALIDATION_ERROR', 'salon_id is required for KYC documents');
      if (!['SALON_OWNER', 'PLATFORM_ADMIN'].includes(req.auth!.role)) {
        throw forbidden('Only the salon owner can upload KYC documents');
      }
      if (req.auth!.role !== 'PLATFORM_ADMIN') {
        const owned = await one(`SELECT id FROM salons WHERE id = $1 AND owner_id = $2`, [
          body.salon_id,
          req.auth!.id,
        ]);
        if (!owned) throw forbidden('You do not manage this salon');
      }
    }

    const purpose = body.purpose === 'kyc_document' ? `kyc/${body.salon_id}` : body.purpose;
    const key = buildObjectKey({
      purpose,
      userId: req.auth!.id,
      contentType: body.content_type,
    });
    return {
      ...presignPut({ key, expiresSec: 900 }),
      content_type: body.content_type,
      purpose: body.purpose,
    };
  });

  app.patch(
    '/users/me/avatar',
    { preHandler: [authenticate, requireRole('CUSTOMER', 'SALON_OWNER', 'SALON_MANAGER', 'STAFF', 'PLATFORM_ADMIN')] },
    async (req) => {
      const body = parse(z.object({ avatar_s3_key: z.string().min(4).max(512).nullable() }), req.body);
      if (body.avatar_s3_key && !body.avatar_s3_key.startsWith(`avatar/${req.auth!.id}/`)) {
        throw badRequest('INVALID_KEY', 'Avatar key does not belong to this user');
      }
      const user = await one(
        `UPDATE users SET avatar_s3_key = $2 WHERE id = $1 RETURNING id, avatar_s3_key`,
        [req.auth!.id, body.avatar_s3_key],
      );
      return user;
    },
  );
};
