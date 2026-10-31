import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  MIGRATE_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_TTL_SEC: z.coerce.number().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().default(30),
  PHONE_ENC_KEY: z.string().length(64),
  PHONE_PEPPER: z.string().min(1),
  DEV_RETURN_OTP: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);
export const isDev = env.NODE_ENV !== 'production';
export const devReturnOtp = isDev && (env.DEV_RETURN_OTP ?? 'true') === 'true';
