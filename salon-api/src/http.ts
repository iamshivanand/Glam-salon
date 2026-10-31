import { z } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('VALIDATION_ERROR', 'Request validation failed', result.error.flatten());
  }
  return result.data;
}

export function parseDate(value: string, field = 'date'): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest('VALIDATION_ERROR', `${field} must be a valid ISO date`);
  return d;
}

export function toInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function pagination(query: Record<string, unknown>) {
  const page = Math.max(1, toInt(query.page, 1));
  const pageSize = Math.min(100, Math.max(1, toInt(query.page_size ?? query.pageSize, 20)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
