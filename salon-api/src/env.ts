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

  // Public web origin used in reminder deep links.
  APP_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  // Notifications. `auto` picks providers from whichever credentials are present.
  NOTIFICATION_PROVIDER: z
    .enum(['auto', 'console', 'webhook', 'twilio', 'whatsapp_cloud', 'resend'])
    .default('auto'),
  ALLOW_CONSOLE_NOTIFICATIONS: z.string().optional(),
  OTP_CHANNEL: z.enum(['SMS', 'WHATSAPP']).default('SMS'),
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),
  NOTIFY_WEBHOOK_SECRET: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SMS_FROM: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),

  // Reminder dispatcher (in-process interval; can also run as a one-shot cron).
  REMINDER_DISPATCH_ENABLED: z.string().optional(),
  REMINDER_DISPATCH_INTERVAL_SEC: z.coerce.number().int().min(1).default(30),
  REMINDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
});

export const env = EnvSchema.parse(process.env);
export const isDev = env.NODE_ENV !== 'production';
export const devReturnOtp = isDev && (env.DEV_RETURN_OTP ?? 'true') === 'true';
export const allowConsoleNotifications = isDev || (env.ALLOW_CONSOLE_NOTIFICATIONS ?? 'false') === 'true';
