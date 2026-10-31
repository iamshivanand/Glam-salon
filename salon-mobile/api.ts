/**
 * Live Glam Connect API client for the Expo app.
 *
 * Base URL:
 *   - Android emulator: http://10.0.2.2:4000/api/v1
 *   - iOS simulator / web: http://localhost:4000/api/v1
 *   - Physical device: http://<your-lan-ip>:4000/api/v1
 * Set EXPO_PUBLIC_API_URL in .env to override.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

let accessToken: string | null = null;
export const setAccessToken = (token: string | null) => {
  accessToken = token;
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function idempotencyKey(): string {
  return `mob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; key?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.key) headers['Idempotency-Key'] = opts.key;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the API at ${API_URL}. Is salon-api running?`);
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json?.error?.code ?? 'ERROR',
      json?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  return json as T;
}

// ------------------------------------------------------------------ formatting
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const IST_OFFSET_MS = 5.5 * 3600_000;

/** Indian digit grouping (12,34,567) without relying on Intl. */
function groupINR(value: number): string {
  const digits = String(Math.abs(Math.round(value)));
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

export function rupees(paise?: number | null): string {
  if (paise == null) return '—';
  return `₹${groupINR(paise / 100)}`;
}

/** Today's date in Asia/Kolkata as YYYY-MM-DD. */
export function todayIST(offsetDays = 0): string {
  return new Date(Date.now() + IST_OFFSET_MS + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** ISO timestamp → "09:00 am" in Asia/Kolkata. */
export function istTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  const h24 = d.getUTCHours();
  const h = h24 % 12 || 12;
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${m} ${h24 >= 12 ? 'pm' : 'am'}`;
}

/** ISO timestamp → "Sat 31 Oct, 09:00 am" in Asia/Kolkata. */
export function istDateTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${istTime(iso)}`;
}

/** "YYYY-MM-DD" → "Today" / "Tomorrow" / "Mon 02 Nov". */
export function dayLabel(dateStr: string): string {
  if (dateStr === todayIST()) return 'Today';
  if (dateStr === todayIST(1)) return 'Tomorrow';
  const d = new Date(`${dateStr}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The next `count` local dates, starting today. */
export function nextDays(count: number): string[] {
  return Array.from({ length: count }, (_, i) => todayIST(i));
}

// ------------------------------------------------------------------ types
export interface SessionUser {
  id: string;
  full_name: string;
  role: 'CUSTOMER' | 'SALON_OWNER' | 'SALON_MANAGER' | 'STAFF' | 'PLATFORM_ADMIN';
  salon_id?: string | null;
  phone?: string;
  phone_masked?: string;
}

export interface SalonCard {
  id: string;
  name: string;
  locality: string;
  city: string;
  description: string | null;
  avg_rating: number;
  review_count: number;
  distance_km: number | null;
  starting_price_paise: number | null;
  live_queue: { waiting_count: number; estimated_wait_mins: number };
  hygiene_badges: string[];
}

export interface SalonService {
  id: string;
  custom_name: string;
  category_name: string;
  category_slug: string;
  description: string | null;
  base_price_paise: number;
  discounted_price_paise: number | null;
  duration_mins: number;
  available_for_home_visit: boolean;
}

export interface SalonStaff {
  id: string;
  display_name: string;
  specialization: string | null;
  avg_rating: number;
  review_count: number;
  is_bgv_verified: boolean;
}

export interface SalonProfile {
  id: string;
  name: string;
  locality: string;
  city: string;
  description: string | null;
  avg_rating: number;
  review_count: number;
  services: SalonService[];
  staff: SalonStaff[];
  reviews: {
    id: string;
    overall_rating: number;
    review_text: string | null;
    customer_name: string;
  }[];
}

export interface Slot {
  start: string;
  start_at: string;
  end_at: string;
  staff_id: string;
  instant_confirm: boolean;
}

export interface MyBooking {
  id: string;
  booking_code: string;
  status: string;
  scheduled_start_at: string;
  total_payable_paise: number;
  salon_name: string;
  locality: string;
  city: string;
  checkin_pin?: string;
}

export interface PartnerBooking {
  id: string;
  booking_code: string;
  status: string;
  scheduled_start_at: string;
  total_payable_paise: number;
  checkin_pin?: string;
  customer_name: string;
  customer_notes?: string | null;
  items: { id: string; service_name: string; staff_name: string | null; price_paise?: number }[];
}

export interface QueueToken {
  token_number: number;
  customer_name: string;
  status: string;
  estimated_wait_mins: number;
}

export interface CreatedBooking {
  id: string;
  booking_code: string;
  checkin_pin: string;
  scheduled_start_at: string;
  total_payable_paise: number;
}

// ------------------------------------------------------------------ auth
export const requestOtp = (phone: string) =>
  api<{ challenge_id: string; expires_in: number; dev_otp?: string }>('/auth/otp/request', {
    method: 'POST',
    body: { phone },
  });

export const verifyOtp = (challengeId: string, otp: string, fullName?: string) =>
  api<{ access_token: string; refresh_token: string; user: SessionUser }>('/auth/otp/verify', {
    method: 'POST',
    body: { challenge_id: challengeId, otp, full_name: fullName },
  });

// ------------------------------------------------------------------ discovery
export const searchSalons = (params: { lat?: number; lng?: number; radius_km?: number } = {}) => {
  const q = new URLSearchParams();
  if (params.lat != null) q.set('lat', String(params.lat));
  if (params.lng != null) q.set('lng', String(params.lng));
  q.set('radius_km', String(params.radius_km ?? 15));
  q.set('sort', 'distance');
  q.set('page_size', '12');
  return api<{ meta: { total: number }; salons: SalonCard[] }>(`/discovery/search?${q.toString()}`);
};

export const getSalon = (salonId: string) => api<SalonProfile>(`/salons/${salonId}`);

export const getAvailability = (salonId: string, serviceIds: string[], date: string, staffId?: string) => {
  const q = new URLSearchParams({ service_ids: serviceIds.join(','), date });
  if (staffId) q.set('staff_id', staffId);
  return api<{ date: string; total_duration_mins: number; slots: Slot[] }>(
    `/salons/${salonId}/availability?${q.toString()}`,
  );
};

// ------------------------------------------------------------------ bookings
export const holdSlot = (body: { salon_id: string; service_ids: string[]; staff_id?: string; start_at: string }) =>
  api<{ hold_token: string; expires_in: number }>('/bookings/hold', { method: 'POST', body });

export const createBooking = (holdToken: string) =>
  api<CreatedBooking>('/bookings', {
    method: 'POST',
    key: idempotencyKey(),
    body: { hold_token: holdToken },
  });

export const myBookings = () => api<{ bookings: MyBooking[] }>('/bookings');

export const cancelBooking = (id: string, reason?: string) =>
  api(`/bookings/${id}/cancel`, { method: 'POST', body: { reason } });

// ------------------------------------------------------------------ partner
export const partnerDashboard = (period: 'TODAY' | 'WEEK' | 'MONTH' = 'MONTH') =>
  api<{
    period: string;
    revenue_paise: number;
    completed_visits: number;
    completed_services: number;
    avg_bill_paise: number;
    retention_rate_pct: number;
    reminder_conversion_rate_pct: number;
    returning_customers: number;
    new_customers: number;
    revenue_by_staff: { staff_name: string; revenue_paise: number }[];
  }>(`/partner/dashboard?period=${period}`);

export const partnerBookings = (date: string) =>
  api<{ date: string; bookings: PartnerBooking[] }>(`/partner/bookings?date=${date}`);

export const partnerQueue = () =>
  api<{ now_serving_token: number | null; waiting_count: number; queue: QueueToken[]; walkin_paused: boolean }>(
    '/partner/queue',
  );

export const updateBookingStatus = (id: string, status: string) =>
  api(`/bookings/${id}/status`, { method: 'PATCH', body: { status } });

export const createInvoice = (bookingId: string, method: 'UPI_QR' | 'CASH') =>
  api<{ invoice_number: string; net_collected_paise: number }>('/partner/invoices', {
    method: 'POST',
    key: idempotencyKey(),
    body: { booking_id: bookingId, method },
  });

export const isOwner = (user: SessionUser | null) =>
  !!user && ['SALON_OWNER', 'SALON_MANAGER', 'PLATFORM_ADMIN'].includes(user.role);
