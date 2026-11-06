'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, logoutSession, onSessionExpired, onTokenChange, setToken } from './api';

export interface SessionUser {
  id: string;
  full_name: string;
  role: 'CUSTOMER' | 'SALON_OWNER' | 'SALON_MANAGER' | 'STAFF' | 'PLATFORM_ADMIN';
  salon_id?: string | null;
  phone?: string;
  phone_masked?: string;
}

interface AuthState {
  token: string | null;
  user: SessionUser | null;
  hydrated: boolean;
  requestOtp: (phone: string) => Promise<{ challenge_id: string; dev_otp?: string; expires_in: number }>;
  verifyOtp: (challengeId: string, otp: string, fullName?: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  setHydrated: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      hydrated: false,
      requestOtp: (phone) =>
        api<{ challenge_id: string; dev_otp?: string; expires_in: number }>('/auth/otp/request', {
          method: 'POST',
          body: { phone },
        }),
      verifyOtp: async (challengeId, otp, fullName) => {
        const res = await api<{ access_token: string; user: SessionUser }>('/auth/otp/verify', {
          method: 'POST',
          body: { challenge_id: challengeId, otp, full_name: fullName },
        });
        setToken(res.access_token);
        set({ token: res.access_token, user: res.user });
        return res.user;
      },
      logout: async () => {
        await logoutSession();
        set({ token: null, user: null });
      },
      setHydrated: () => set({ hydrated: true }),
    }),
    {
      name: 'gc_session',
      partialize: (state) => ({ token: state.token, user: state.user }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
        const token = state?.token ?? null;
        setToken(token);
      },
    },
  ),
);

export const isOwner = (user: SessionUser | null) =>
  !!user && ['SALON_OWNER', 'SALON_MANAGER', 'PLATFORM_ADMIN'].includes(user.role);

// ------------------------------------------------------------------ booking draft
interface BookingState {
  salonId?: string;
  serviceIds: string[];
  staffId?: string;
  date: string;
  time?: string;
  setSalon: (salonId: string) => void;
  toggleService: (id: string) => void;
  set: (p: Partial<Pick<BookingState, 'staffId' | 'date' | 'time' | 'salonId' | 'serviceIds'>>) => void;
  reset: () => void;
}

function istToday() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export const useBooking = create<BookingState>()(
  persist(
    (set, get) => ({
      salonId: undefined,
      serviceIds: [],
      staffId: undefined,
      date: istToday(),
      time: undefined,
      setSalon: (salonId) => {
        if (get().salonId !== salonId) set({ salonId, serviceIds: [], staffId: undefined, time: undefined });
      },
      toggleService: (id) =>
        set((s) => ({
          serviceIds: s.serviceIds.includes(id) ? s.serviceIds.filter((x) => x !== id) : [...s.serviceIds, id],
          time: undefined,
        })),
      set: (p) => set({ ...p, time: p.time ?? (p.date ? undefined : get().time) }),
      reset: () => set({ serviceIds: [], staffId: undefined, time: undefined }),
    }),
    { name: 'gc_booking', partialize: (s) => ({ salonId: s.salonId, serviceIds: s.serviceIds, date: s.date }) },
  ),
);

// ------------------------------------------------------------------ auth modal
interface AuthModalState {
  open: boolean;
  reason?: string;
  openModal: (reason?: string) => void;
  closeModal: () => void;
}

export const useAuthModal = create<AuthModalState>((set) => ({
  open: false,
  reason: undefined,
  openModal: (reason) => set({ open: true, reason }),
  closeModal: () => set({ open: false }),
}));

// Keep the persisted session in sync when api.ts refreshes or drops the token.
onTokenChange((token) => useAuth.setState({ token }));
onSessionExpired(() => useAuth.setState({ token: null, user: null }));
