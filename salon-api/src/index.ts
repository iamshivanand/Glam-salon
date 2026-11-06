import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { env, isDev } from './env.js';
import { AppError } from './http.js';
import { closeDb, one } from './db.js';
import { closeRedis, redis } from './redis.js';
import { authRoutes } from './routes/auth.js';
import { discoveryRoutes } from './routes/discovery.js';
import { bookingRoutes } from './routes/bookings.js';
import { queueRoutes } from './routes/queue.js';
import { partnerRoutes } from './routes/partner.js';
import { adminRoutes } from './routes/admin.js';
import { startReminderDispatcher, type DispatchLog } from './services/dispatcher.js';
import { notifier } from './services/notifications.js';

export async function buildApp() {
  const app = Fastify({
    logger: isDev
      ? {
          level: 'info',
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : { level: 'info' },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  const origins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, {
    origin: origins.includes('*') ? true : origins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Salon-Id'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie);

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details ?? undefined },
      });
    }
    if (err?.validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: err.message },
      });
    }
    if (err?.code === '23P01') {
      return reply.status(409).send({
        error: { code: 'SLOT_TAKEN', message: 'That time slot is no longer available.' },
      });
    }
    if (err?.code === '23505') {
      return reply.status(409).send({
        error: { code: 'DUPLICATE', message: 'That record already exists.', details: err.detail },
      });
    }
    if (err?.code === '23503') {
      return reply.status(400).send({
        error: { code: 'INVALID_REFERENCE', message: 'A referenced record does not exist.' },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` },
    });
  });

  app.get('/health', async (_req, reply) => {
    const checks: Record<string, string> = { api: 'ok' };
    try {
      await one('SELECT 1 AS ok');
      checks.database = 'ok';
    } catch {
      checks.database = 'down';
    }
    try {
      checks.redis = (await redis.ping()) === 'PONG' ? 'ok' : 'down';
    } catch {
      checks.redis = 'down';
    }
    const healthy = checks.database === 'ok' && checks.redis === 'ok';
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      checks,
      notifications: notifier.describe(),
      time: new Date().toISOString(),
    });
  });

  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(discoveryRoutes, { prefix: '/api/v1' });
  await app.register(bookingRoutes, { prefix: '/api/v1' });
  await app.register(queueRoutes, { prefix: '/api/v1' });
  await app.register(partnerRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });

  return app;
}

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  app.log.info({ notifications: notifier.describe() }, 'notification providers');
  const stopDispatcher = startReminderDispatcher(app.log as unknown as DispatchLog);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      stopDispatcher();
      await app.close();
      await closeDb();
      await closeRedis();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && /index\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
