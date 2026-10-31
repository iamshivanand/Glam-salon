import type { FastifyRequest } from 'fastify';

export type UserRole = 'CUSTOMER' | 'SALON_OWNER' | 'SALON_MANAGER' | 'STAFF' | 'PLATFORM_ADMIN';

export interface AuthUser {
  id: string;
  role: UserRole;
  salonId?: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthUser;
  }
}

export type AuthedRequest = FastifyRequest & { auth: AuthUser };
