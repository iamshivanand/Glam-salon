import { create } from 'zustand';
import { services, staff, appointments, buildStats, slotsFor, salon } from '../salon-contracts/src/mock-data';

// Mock API with latency — same shapes as web /api/*. Swap baseURL for real backend later.
const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
export const mockApi = {
  async getServices() { await wait(); return services; },
  async getStaff() { await wait(); return staff; },
  async getAppointments() { await wait(); return [...appointments].slice(-25).reverse(); },
  async getSlots(date: string, staffId?: string) { await wait(250); return slotsFor(date, staffId); },
  async getStats() { await wait(); return buildStats(); },
  async createBooking(body: any) { await wait(600); return { id: 'ap-mob-' + Date.now(), status: 'confirmed', ...body }; },
  salon,
};

interface AuthState { role: 'customer' | 'owner'; switchRole: (r: 'customer' | 'owner') => void; }
export const useAuth = create<AuthState>((set) => ({ role: 'customer', switchRole: (role) => set({ role }) }));

interface BookingState {
  tab: string; serviceIds: string[]; staffId?: string; date: string; time?: string;
  setTab: (t: string) => void; toggleService: (id: string) => void; set: (p: Partial<BookingState>) => void;
}
export const useBooking = create<BookingState>((set) => ({
  tab: 'home', serviceIds: ['sv-1'], staffId: undefined,
  date: new Date().toISOString().slice(0, 10), time: undefined,
  setTab: (tab) => set({ tab }),
  toggleService: (id) => set((s) => ({ serviceIds: s.serviceIds.includes(id) ? s.serviceIds.filter((x) => x !== id) : [...s.serviceIds, id] })),
  set: (p) => set(p),
}));
