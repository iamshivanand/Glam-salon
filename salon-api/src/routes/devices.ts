import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { query } from '../db.js';
import { parse } from '../http.js';
import { authenticate } from '../auth.js';

const DeviceInput = z.object({
  token: z.string().min(16).max(512),
  platform: z.enum(['ios', 'android', 'web', 'unknown']).default('unknown'),
  app: z.enum(['customer', 'partner']).default('customer'),
});

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  app.post('/users/me/devices', { preHandler: [authenticate] }, async (req) => {
    const body = parse(DeviceInput, req.body);
    const row = await query(
      `INSERT INTO device_push_tokens (user_id, token, platform, app, last_seen_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             platform = EXCLUDED.platform,
             app = EXCLUDED.app,
             last_seen_at = NOW()
       RETURNING id, platform, app, last_seen_at`,
      [req.auth!.id, body.token, body.platform, body.app],
    );
    return { device: row[0] };
  });

  app.delete('/users/me/devices/:token', { preHandler: [authenticate] }, async (req) => {
    const { token } = req.params as { token: string };
    await query(`DELETE FROM device_push_tokens WHERE token = $1 AND user_id = $2`, [token, req.auth!.id]);
    return { ok: true };
  });
};
