import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db.js';
import { parse, AppError, badRequest, conflict, notFound, forbidden } from '../http.js';
import { authenticate, requireRole } from '../auth.js';
import {
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  StorageNotConfigured,
  buildObjectKey,
  deleteObject,
  headObject,
  maxBytesFor,
  presignGet,
  presignPut,
  storageConfigured,
  storageProviderName,
} from '../services/storage.js';
import { recordAudit } from '../services/audit.js';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

const PresignInput = z.object({
  purpose: z.enum(['avatar', 'kyc_document', 'style_photo']),
  content_type: z.enum(ALLOWED_CONTENT_TYPES),
  size_bytes: z.number().int().positive().max(MAX_PDF_BYTES),
  salon_id: z.string().uuid().optional(),
});

interface UploadRow {
  id: string;
  user_id: string;
  salon_id: string | null;
  purpose: string;
  s3_key: string;
  declared_content_type: string;
  declared_size_bytes: number | null;
  actual_content_type: string | null;
  actual_size_bytes: string | null;
  status: string;
  rejection_reason: string | null;
  created_at: string;
  confirmed_at: string | null;
}

function uploadView(row: UploadRow) {
  return {
    upload_id: row.id,
    key: row.s3_key,
    purpose: row.purpose,
    salon_id: row.salon_id,
    status: row.status,
    content_type: row.actual_content_type ?? row.declared_content_type,
    size_bytes: row.actual_size_bytes ? Number(row.actual_size_bytes) : row.declared_size_bytes,
    confirmed_at: row.confirmed_at,
  };
}

function storageUnavailable(): AppError {
  return new AppError(
    503,
    'STORAGE_NOT_CONFIGURED',
    'Object storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
  );
}

async function assertSalonAccess(userId: string, role: string, salonId: string): Promise<void> {
  if (role === 'PLATFORM_ADMIN') return;
  const linked = await one(
    `SELECT 1 AS ok FROM salons WHERE id = $1 AND owner_id = $2
     UNION ALL
     SELECT 1 FROM staff_members WHERE salon_id = $1 AND user_id = $2 AND is_active`,
    [salonId, userId],
  );
  if (!linked) throw forbidden('You do not manage this salon');
}

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.get('/uploads/status', async () => ({
    provider: storageProviderName(),
    configured: storageConfigured(),
    allowed_content_types: ALLOWED_CONTENT_TYPES,
    max_image_bytes: MAX_IMAGE_BYTES,
    max_pdf_bytes: MAX_PDF_BYTES,
    note: 'Presigned uploads write directly to object storage. The API never proxies file bytes.',
  }));

  /**
   * Step 1: reserve an object key. The declared type and size are signed into
   * the URL and checked again after upload, so a client cannot quietly store a
   * larger file or a different content type.
   */
  app.post('/uploads/presign', { preHandler: [authenticate] }, async (req) => {
    const body = parse(PresignInput, req.body);
    if (!storageConfigured()) throw storageUnavailable();

    const maxBytes = maxBytesFor(body.content_type);
    if (!maxBytes) throw badRequest('UNSUPPORTED_CONTENT_TYPE', 'That file type is not allowed');
    if (body.size_bytes > maxBytes) {
      throw badRequest(
        'FILE_TOO_LARGE',
        `Files of this type must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller`,
      );
    }

    if (body.purpose === 'kyc_document') {
      if (!body.salon_id) throw badRequest('VALIDATION_ERROR', 'salon_id is required for KYC documents');
      await assertSalonAccess(req.auth!.id, req.auth!.role, body.salon_id);
    }

    const purpose = body.purpose === 'kyc_document' ? `kyc/${body.salon_id}` : body.purpose;
    const key = buildObjectKey({
      purpose,
      userId: req.auth!.id,
      contentType: body.content_type,
    });

    const row = await one<UploadRow>(
      `INSERT INTO uploads
         (user_id, salon_id, purpose, s3_key, declared_content_type, declared_size_bytes, status)
       VALUES ($1,$2,$3,$4,$5,$6,'PRESIGNED')
       RETURNING *`,
      [req.auth!.id, body.salon_id ?? null, body.purpose, key, body.content_type, body.size_bytes],
    );

    return {
      ...uploadView(row!),
      ...presignPut({ key, expiresSec: 900, contentType: body.content_type }),
    };
  });

  /**
   * Step 2: prove the bytes landed. HEADs the object, checks the stored
   * content type and size, and marks the upload usable. Repeating this call is
   * safe and returns the same upload.
   */
  app.post('/uploads/confirm', { preHandler: [authenticate] }, async (req) => {
    const body = parse(z.object({ upload_id: z.string().uuid() }), req.body);
    const upload = await one<UploadRow>(`SELECT * FROM uploads WHERE id = $1 AND user_id = $2`, [
      body.upload_id,
      req.auth!.id,
    ]);
    if (!upload) throw notFound('Upload not found');
    if (upload.status === 'UPLOADED') return uploadView(upload);
    if (upload.status === 'REJECTED' || upload.status === 'DELETED') {
      throw conflict('UPLOAD_REJECTED', upload.rejection_reason ?? 'This upload was rejected');
    }

    let head;
    try {
      head = await headObject(upload.s3_key);
    } catch (err) {
      if (err instanceof StorageNotConfigured) throw storageUnavailable();
      throw new AppError(502, 'STORAGE_UNAVAILABLE', 'Could not verify the uploaded file');
    }
    if (!head) throw badRequest('UPLOAD_NOT_FOUND', 'No object was uploaded for this key');

    const expectedType = upload.declared_content_type.toLowerCase();
    const actualType = (head.contentType ?? '').split(';')[0].trim().toLowerCase();
    const maxBytes = maxBytesFor(expectedType) ?? MAX_IMAGE_BYTES;
    const reasons: string[] = [];

    if (!actualType) reasons.push('the uploaded object has no content type');
    else if (actualType !== expectedType) {
      reasons.push(`content type ${actualType} does not match the declared ${expectedType}`);
    }
    if (!Number.isFinite(head.contentLength) || head.contentLength <= 0) reasons.push('the file is empty');
    else if (head.contentLength > maxBytes) {
      reasons.push(`the file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB`);
    }

    if (reasons.length) {
      const reason = reasons.join('; ');
      await query(`UPDATE uploads SET status = 'REJECTED', rejection_reason = $2 WHERE id = $1`, [
        upload.id,
        reason,
      ]);
      void deleteObject(upload.s3_key).catch(() => undefined);
      throw badRequest('UPLOAD_INVALID', reason);
    }

    const updated = await one<UploadRow>(
      `UPDATE uploads
          SET status = 'UPLOADED',
              actual_content_type = $2,
              actual_size_bytes = $3,
              confirmed_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [upload.id, actualType, head.contentLength],
    );
    return uploadView(updated!);
  });

  /** Owner read URL. Platform admins use the audited KYC document endpoint. */
  app.get('/uploads/:id/url', { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const upload = await one<UploadRow>(`SELECT * FROM uploads WHERE id = $1`, [id]);
    if (!upload) throw notFound('Upload not found');
    if (upload.user_id !== req.auth!.id) throw forbidden('This upload belongs to another account');
    if (upload.status !== 'UPLOADED') throw badRequest('UPLOAD_NOT_READY', 'Confirm the upload before reading it');
    if (!storageConfigured()) throw storageUnavailable();
    return presignGet(upload.s3_key, 300);
  });

  app.patch(
    '/users/me/avatar',
    { preHandler: [authenticate, requireRole('CUSTOMER', 'SALON_OWNER', 'SALON_MANAGER', 'STAFF', 'PLATFORM_ADMIN')] },
    async (req) => {
      const body = parse(z.object({ avatar_s3_key: z.string().min(4).max(512).nullable() }), req.body);
      if (body.avatar_s3_key) {
        const upload = await one<{ purpose: string; status: string }>(
          `SELECT purpose, status FROM uploads WHERE s3_key = $1 AND user_id = $2`,
          [body.avatar_s3_key, req.auth!.id],
        );
        if (!upload || upload.purpose !== 'avatar' || upload.status !== 'UPLOADED') {
          throw badRequest('INVALID_KEY', 'Avatar must be a confirmed upload owned by this user');
        }
      }
      const user = await one(
        `UPDATE users SET avatar_s3_key = $2 WHERE id = $1 RETURNING id, avatar_s3_key`,
        [req.auth!.id, body.avatar_s3_key],
      );
      return user;
    },
  );

  /** Admin-only audited read of a KYC document. The key never leaves the API. */
  app.get('/admin/kyc/:salonId/document', { preHandler: [authenticate] }, async (req) => {
    if (req.auth!.role !== 'PLATFORM_ADMIN') throw forbidden('Requires role: PLATFORM_ADMIN');
    const { salonId } = req.params as { salonId: string };
    const row = await one<{ shop_license_s3_key: string | null }>(
      `SELECT shop_license_s3_key FROM salon_kyc_verifications WHERE salon_id = $1`,
      [salonId],
    );
    if (!row?.shop_license_s3_key) throw notFound('No KYC document on file');
    if (!storageConfigured()) throw storageUnavailable();
    await recordAudit({
      actorId: req.auth!.id,
      actorRole: req.auth!.role,
      salonId,
      action: 'kyc.document.viewed',
      entityType: 'salon_kyc_verification',
      entityId: salonId,
      ip: req.ip,
    });
    return {
      ...presignGet(row.shop_license_s3_key, 300),
      key: row.shop_license_s3_key,
    };
  });
};
