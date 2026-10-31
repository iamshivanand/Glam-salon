import { Redis } from 'ioredis';
import { env } from './env.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('error', (err: Error) => {
  console.error('[redis] error', err.message);
});

export async function closeRedis(): Promise<void> {
  await redis.quit();
}

/** Fixed-window rate limiter. Returns true when the call is allowed. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; remaining: number }> {
  const current = await redis.incr(key);
  if (current === 1) await redis.expire(key, windowSec);
  return { allowed: current <= limit, remaining: Math.max(0, limit - current) };
}
