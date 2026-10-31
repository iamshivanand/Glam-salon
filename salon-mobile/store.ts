import { create } from 'zustand';
import {
  api,
  setAccessToken,
  todayIST,
  type SessionUser,
} from './api';

// ------------------------------------------------------------------ auth
interface AuthState {
  token: string | null;
  user: SessionUser | null;
  requestOtp: (phone: string) => Promise<{ challenge_id: string; expires_in: number; dev_otp?: string }>;
  verifyOtp: (challengeId: string, otp: string, fullName?: string) => Promise<SessionUser>;
  logout: () => void;
}

/**
 * Sessions are held in memory only: closing the app signs you out. Persisting the
 * token would need expo-secure-store, which this prototype does not install.
 */
export const useAuth = create<AuthState>((set) => ({
  token: null,
  user: null,
  requestOtp: (phone) =>
    api<{ challenge_id: string; expires_in: number; dev_otp?: string }>('/auth/otp/request', {
      method: 'POST',
      body: { phone },
    }),
  verifyOtp: async (challengeId, otp, fullName) => {
    const res = await api<{ access_token: string; user: SessionUser }>('/auth/otp/verify', {
      method: 'POST',
      body: { challenge_id: challengeId, otp, full_name: fullName },
    });
    setAccessToken(res.access_token);
    set({ token: res.access_token, user: res.user });
    return res.user;
  },
  logout: () => {
    setAccessToken(null);
    set({ token: null, user: null });
  },
}));

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

export const useBooking = create<BookingState>((set, get) => ({
  salonId: undefined,
  serviceIds: [],
  staffId: undefined,
  date: todayIST(),
  time: undefined,
  setSalon: (salonId) => {
    if (get().salonId !== salonId) set({ salonId, serviceIds: [], staffId: undefined, time: undefined });
  },
  toggleService: (id) =>
    set((s) => ({
      serviceIds: s.serviceIds.includes(id) ? s.serviceIds.filter((x) => x !== id) : [...s.serviceIds, id],
      time: undefined,
    })),
  set: (p) =>
    set({
      ...p,
      // Changing the date or artist invalidates the chosen slot.
      time:
        p.time !== undefined
          ? p.time
          : p.date !== undefined || p.staffId !== undefined
            ? undefined
            : get().time,
    }),
  reset: () => set({ serviceIds: [], staffId: undefined, time: undefined }),
}));

// ------------------------------------------------------------------ navigation + auth modal
export type Tab = 'home' | 'book' | 'visits' | 'admin';

interface UiState {
  tab: Tab;
  setTab: (tab: Tab) => void;
  authOpen: boolean;
  authReason?: string;
  resumeBooking: boolean;
  openAuth: (reason?: string, resumeBooking?: boolean) => void;
  closeAuth: (keepResume?: boolean) => void;
  clearResume: () => void;
}

export const useUi = create<UiState>((set, get) => ({
  tab: 'home',
  setTab: (tab) => set({ tab }),
  authOpen: false,
  authReason: undefined,
  resumeBooking: false,
  openAuth: (reason, resumeBooking = false) =>
    set({ authOpen: true, authReason: reason, resumeBooking }),
  // keepResume=true is used after a successful OTP verify so the booking screen
  // can finish the hold/confirm it started before asking for a sign-in.
  closeAuth: (keepResume = false) =>
    set({
      authOpen: false,
      authReason: undefined,
      resumeBooking: keepResume ? get().resumeBooking : false,
    }),
  clearResume: () => set({ resumeBooking: false }),
}));
