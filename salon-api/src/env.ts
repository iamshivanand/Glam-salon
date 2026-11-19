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

  // Public origins. API_PUBLIC_URL is used for click redirects and provider callbacks.
  APP_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),

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
  TRANSACTIONAL_CHANNEL: z.enum(['SMS', 'WHATSAPP', 'EMAIL']).default('SMS'),
  DELIVERY_WEBHOOK_SECRET: z.string().optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),

  // WhatsApp/Meta compliance. Templates are required for business-initiated
  // messages; text sends still work inside a customer service window.
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_TEMPLATES_ENABLED: z.string().optional(),
  // JSON: { "OTP_V1": "otp_verification", "BOOKING_CONFIRMED": "booking_confirmed" }
  WHATSAPP_TEMPLATE_MAP: z.string().optional(),
  // JSON: { "OTP_V1": "HX..." } for Twilio Content API templates.
  TWILIO_CONTENT_SID_MAP: z.string().optional(),

  // Payments. `manual` records pay-at-salon intent; `razorpay` uses the live API.
  PAYMENT_PROVIDER: z.enum(['none', 'manual', 'razorpay']).default('manual'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // S3-compatible object storage for KYC documents, avatars and style photos.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.string().optional(),

  // Reminder dispatcher (in-process interval; can also run as a one-shot cron).
  REMINDER_DISPATCH_ENABLED: z.string().optional(),
  REMINDER_DISPATCH_INTERVAL_SEC: z.coerce.number().int().min(1).default(30),
  REMINDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  // Operational endpoints.
  METRICS_ENABLED: z.string().optional(),
  METRICS_TOKEN: z.string().min(16).optional(),
});

export const env = EnvSchema.parse(process.env);
export const isDev = env.NODE_ENV !== 'production';
export const devReturnOtp = isDev && (env.DEV_RETURN_OTP ?? 'true') === 'true';
export const allowConsoleNotifications = isDev || (env.ALLOW_CONSOLE_NOTIFICATIONS ?? 'false') === 'true';
