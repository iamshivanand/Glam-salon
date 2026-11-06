import { create } from 'zustand';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import {
  api,
  logoutRequest,
  onTokenRefreshed,
  setAccessToken,
  setRefreshToken,
  setSessionExpiredHandler,
  todayIST,
  type SessionUser,
} from './api';

// ------------------------------------------------------------------ auth
const SESSION_KEY = 'gc_session_v1';

interface PersistedSession {
  access_token: string;
  refresh_token: string;
  user: SessionUser;
}

async function readSession(): Promise<PersistedSession | null> {
  try {
    const raw =
      Platform.OS === 'web'
        ? typeof localStorage !== 'undefined'
          ? localStorage.getItem(SESSION_KEY)
          : null
        : await SecureStore.getItemAsync(SESSION_KEY);
    return raw ? (JSON.parse(raw) as PersistedSession) : null;
  } catch {
    return null;
  }
}

async function writeSession(value: PersistedSession | null): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return;
      if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else localStorage.removeItem(SESSION_KEY);
      return;
    }
    if (value) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(value));
    else await SecureStore.deleteItemAsync(SESSION_KEY);
  } catch {
    // Storage failures must never block sign-in; the session stays in memory.
  }
}

interface AuthState {
  token: string | null;
  user: SessionUser | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  requestOtp: (phone: string) => Promise<{ challenge_id: string; expires_in: number; dev_otp?: string }>;
  verifyOtp: (challengeId: string, otp: string, fullName?: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  token: null,
  user: null,
  hydrated: false,
  hydrate: async () => {
    const stored = await readSession();
    if (stored) {
      setAccessToken(stored.access_token);
      setRefreshToken(stored.refresh_token);
      set({ token: stored.access_token, user: stored.user, hydrated: true });
    } else {
      set({ hydrated: true });
    }
  },
  requestOtp: (phone) =>
    api<{ challenge_id: string; expires_in: number; dev_otp?: string }>('/auth/otp/request', {
      method: 'POST',
      body: { phone },
    }),
  verifyOtp: async (challengeId, otp, fullName) => {
    const res = await api<{ access_token: string; refresh_token: string; user: SessionUser }>(
      '/auth/otp/verify',
      {
        method: 'POST',
        body: { challenge_id: challengeId, otp, full_name: fullName },
      },
    );
    setAccessToken(res.access_token);
    setRefreshToken(res.refresh_token);
    await writeSession(res);
    set({ token: res.access_token, user: res.user });
    return res.user;
  },
  logout: async () => {
    await logoutRequest();
    await writeSession(null);
    set({ token: null, user: null });
  },
}));

// Rotated tokens must be persisted, otherwise a reload would replay a dead
// refresh token and sign the user out.
onTokenRefreshed((access_token, refresh_token) => {
  const user = useAuth.getState().user;
  if (!user) return;
  void writeSession({ access_token, refresh_token, user });
  useAuth.setState({ token: access_token });
});

setSessionExpiredHandler(() => {
  void writeSession(null);
  useAuth.setState({ token: null, user: null });
});

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
