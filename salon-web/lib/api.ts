'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const TOKEN_KEY = 'gc_token';
const SALON_KEY = 'gc_active_salon';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let tokenChangeHandler: ((token: string | null) => void) | null = null;
let sessionExpiredHandler: (() => void) | null = null;
let refreshInFlight: Promise<string | null> | null = null;

/** Registered by the auth store so refreshed/cleared tokens stay in sync with React state. */
export function onTokenChange(handler: (token: string | null) => void) {
  tokenChangeHandler = handler;
}

/** Registered by the auth store so a dead refresh session clears the signed-in user. */
export function onSessionExpired(handler: () => void) {
  sessionExpiredHandler = handler;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
  tokenChangeHandler?.(token);
}

/** Multi-salon owners pick the active salon here; every partner call sends X-Salon-Id. */
export function getActiveSalonId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SALON_KEY);
}

export function setActiveSalonId(salonId: string | null) {
  if (typeof window === 'undefined') return;
  if (salonId) window.localStorage.setItem(SALON_KEY, salonId);
  else window.localStorage.removeItem(SALON_KEY);
  window.dispatchEvent(new CustomEvent('gc:salon-changed', { detail: salonId }));
}

/**
 * Exchange the HttpOnly refresh cookie for a fresh access token.
 * Concurrent 401s share one in-flight request so we never rotate the same
 * refresh token twice.
 */
export async function refreshSession(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { access_token?: string };
        if (!json?.access_token) return null;
        setToken(json.access_token);
        return json.access_token;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/** Revoke the refresh token server-side, then clear local state. */
export async function logoutSession(): Promise<void> {
  try {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    // Offline logout still clears the local session.
  } finally {
    setToken(null);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);

  const request = (token: string | null) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.key) headers['Idempotency-Key'] = opts.key;
    const salonId = getActiveSalonId();
    if (salonId) headers['X-Salon-Id'] = salonId;
    return fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: payload,
      credentials: 'include',
    });
  };

  let token = getToken();
  let res = await request(token);

  // Access tokens live 15 minutes. Try the refresh cookie once before giving up.
  if (res.status === 401 && token && !path.startsWith('/auth/')) {
    const fresh = await refreshSession();
    if (fresh) {
      token = fresh;
      res = await request(fresh);
    } else {
      setToken(null);
      sessionExpiredHandler?.();
    }
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/auth/')) {
      setToken(null);
      sessionExpiredHandler?.();
    }
    throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `Request failed (${res.status})`, json?.error?.details);
  }
  return json as T;
}

export function rupees(paise?: number | null): string {
  if (paise == null) return '—';
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const qk = {
  salons: (p: unknown) => ['salons', p] as const,
  salon: (id?: string) => ['salon', id] as const,
  categories: ['categories'] as const,
  availability: (salonId?: string, services?: string[], date?: string, staff?: string) =>
    ['availability', salonId, services?.join(','), date, staff] as const,
  addons: (salonId?: string, primary?: string, staff?: string) => ['addons', salonId, primary, staff] as const,
  myBookings: ['my-bookings'] as const,
  dashboard: (period: string) => ['partner', 'dashboard', period] as const,
  partnerBookings: (date: string) => ['partner', 'bookings', date] as const,
  partnerServices: ['partner', 'services'] as const,
  partnerStaff: ['partner', 'staff'] as const,
  partnerCrm: ['partner', 'crm'] as const,
  partnerReminders: ['partner', 'reminders'] as const,
  partnerQueue: ['partner', 'queue'] as const,
  partnerInvoices: ['partner', 'invoices'] as const,
  partnerReviews: ['partner', 'reviews'] as const,
  partnerResources: ['partner', 'resources'] as const,
  partnerCrmDetail: (customerId: string) => ['partner', 'crm', customerId] as const,
};

export interface SalonCard {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  salon_type: string;
  address_line: string;
  locality: string;
  city: string;
  distance_km: number | null;
  avg_rating: number;
  review_count: number;
  is_sponsored: boolean;
  hygiene_badges: string[];
  starting_price_paise: number | null;
  next_available_slot: string | null;
  live_queue: { waiting_count: number; estimated_wait_mins: number };
}

export interface SearchResponse {
  meta: { total: number; page: number; page_size: number };
  salons: SalonCard[];
}

export interface SalonService {
  id: string;
  salon_id: string;
  category_id: string;
  category_name: string;
  category_slug: string;
  custom_name: string;
  description: string | null;
  base_price_paise: number;
  discounted_price_paise: number | null;
  duration_mins: number;
  buffer_after_mins: number;
  requires_resource_type: string | null;
  available_for_home_visit: boolean;
  is_active: boolean;
}

export interface SalonStaff {
  id: string;
  display_name: string;
  specialization: string | null;
  experience_years: number;
  is_bgv_verified: boolean;
  avg_rating: number;
  review_count: number;
  home_visit_enabled: boolean;
}

export interface SalonProfile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  salon_type: string;
  address_line: string;
  locality: string;
  city: string;
  avg_rating: number;
  review_count: number;
  supports_at_home: boolean;
  operating_hours: Record<string, { open: string | null; close: string | null }>;
  hygiene_facilities: Record<string, boolean> | null;
  services: SalonService[];
  staff: SalonStaff[];
  reviews: {
    id: string;
    overall_rating: number;
    hygiene_rating: number;
    review_text: string | null;
    created_at: string;
    customer_name: string;
    staff_name: string | null;
  }[];
}

export interface Slot {
  start: string;
  end: string;
  start_at: string;
  end_at: string;
  staff_id: string;
  resource_id: string | null;
  instant_confirm: boolean;
}

export interface MyBooking {
  id: string;
  booking_code: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  total_payable_paise: number;
  subtotal_paise?: number;
  tax_paise?: number;
  salon_name: string;
  locality: string;
  city: string;
  checkin_pin?: string;
  review_id?: string | null;
  items?: {
    id: string;
    service_name: string;
    status: string;
    unit_price_paise: number;
  }[];
}

export interface PartnerBooking {
  id: string;
  booking_code: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  total_payable_paise: number;
  checkin_pin: string;
  customer_name: string;
  customer_notes: string | null;
  items: {
    id: string;
    service_name: string;
    staff_name: string | null;
    start_at: string;
    end_at: string;
    price_paise: number;
    status: string;
  }[];
}

// ------------------------------------------------------------------ customer
export function useSalonSearch(params: { lat?: number; lng?: number; radius_km?: number; q?: string; category_id?: string; sort?: string }) {
  return useQuery({
    queryKey: qk.salons(params),
    queryFn: () => api<SearchResponse>(`/discovery/search${qs({ ...params, page_size: 12 })}`),
    staleTime: 60_000,
  });
}

export interface UrgentSlotMatch {
  salon_id: string;
  salon_name: string;
  distance_km: number | null;
  travel_eta_mins: number;
  earliest_slot_start: string;
  starts_in_mins: number;
  staff_id: string;
  staff_name: string | null;
  price_paise: number;
  flash_deal_discount_paise: number;
  instant_confirm_guaranteed: boolean;
}

export function useUrgentSlots(params: {
  lat?: number;
  lng?: number;
  radius_km?: number;
  category_id?: string;
  within_mins?: number;
}) {
  return useQuery({
    queryKey: ['urgent-slots', params],
    queryFn: () => api<{ urgent_matches: UrgentSlotMatch[] }>(`/discovery/urgent-slots${qs(params)}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useSalon(id?: string) {
  return useQuery({
    queryKey: qk.salon(id),
    queryFn: () => api<SalonProfile>(`/salons/${id}`),
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function useCategories() {
  return useQuery({
    queryKey: qk.categories,
    queryFn: () => api<{ categories: { id: string; name: string; slug: string }[] }>('/categories'),
    staleTime: 5 * 60_000,
  });
}

export interface SalonComparisonItem {
  salon_id: string;
  salon_name: string;
  service_name: string | null;
  price_paise: number | null;
  pricing_model: 'FIXED' | 'STARTING_FROM_QUOTE' | null;
  duration_mins: number | null;
  facilities: {
    has_private_room: boolean;
    uses_disposable_kits: boolean;
    autoclave_sterilization: boolean;
    wheelchair_accessible: boolean;
    has_women_only_zone: boolean;
    verified_by_admin_name?: string | null;
    verified_at?: string | null;
  } | null;
  next_slot: string | null;
  queue_wait_mins: number;
  queue_waiting_count?: number;
}

export function useCompareSalons(salonIds: string[], categoryId?: string, enabled = true) {
  return useQuery({
    queryKey: ['compare', salonIds.join(','), categoryId],
    queryFn: () =>
      api<{ category: string; comparison: SalonComparisonItem[] }>(
        `/discovery/compare${qs({ salon_ids: salonIds.join(','), category_id: categoryId })}`,
      ),
    enabled: enabled && salonIds.length >= 2 && !!categoryId,
  });
}

export function useAvailability(salonId?: string, serviceIds: string[] = [], date?: string, staffId?: string) {
  return useQuery({
    queryKey: qk.availability(salonId, serviceIds, date, staffId),
    queryFn: () =>
      api<{ date: string; total_duration_mins: number; slots: Slot[] }>(
        `/salons/${salonId}/availability${qs({ service_ids: serviceIds.join(','), date, staff_id: staffId })}`,
      ),
    enabled: !!salonId && serviceIds.length > 0 && !!date,
  });
}

export interface AddonRecommendation {
  addon_mapping_id: string;
  primary_service_id: string;
  addon_service_id: string;
  bundle_discount_paise: number;
  priority_rank: number;
  service_id: string;
  name: string;
  description: string | null;
  base_price_paise: number;
  discounted_price_paise: number | null;
  bundle_price_paise: number;
  duration_mins: number;
  buffer_after_mins: number;
  category_name: string;
}

export function useAddonRecommendations(salonId?: string, serviceIds?: string | string[], staffId?: string) {
  const serviceIdsStr = Array.isArray(serviceIds) ? serviceIds.filter(Boolean).join(',') : (serviceIds ?? '');
  return useQuery({
    queryKey: qk.addons(salonId, serviceIdsStr, staffId),
    queryFn: () =>
      api<{ addons: AddonRecommendation[] }>(
        `/salons/${salonId}/addons/recommend${qs({ service_ids: serviceIdsStr, staff_id: staffId })}`,
      ),
    enabled: !!salonId,
  });
}

export function useMyBookings(enabled = true) {
  return useQuery({
    queryKey: qk.myBookings,
    queryFn: () => api<{ bookings: MyBooking[] }>('/bookings'),
    enabled,
  });
}

export function useHold() {
  return useMutation({
    mutationFn: (body: { salon_id: string; service_ids: string[]; staff_id?: string; start_at: string }) =>
      api<{ hold_token: string; expires_in: number; pricing: { subtotal_paise: number; tax_paise: number; total_payable_paise: number } }>(
        '/bookings/hold',
        { method: 'POST', body },
      ),
  });
}

export function useCreateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { hold_token: string; customer_notes?: string; reminder_token?: string; payment_mode?: string }) =>
      api<{ id: string; booking_code: string; status: string; checkin_pin: string; scheduled_start_at: string; total_payable_paise: number }>(
        '/bookings',
        { method: 'POST', body, key: crypto.randomUUID() },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.myBookings });
    },
  });
}

export function useCancelBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, cancel_item_ids }: { id: string; reason?: string; cancel_item_ids?: string[] }) =>
      api<{
        status: string;
        cancellation_fee_paise: number;
        refund_due_paise: number;
        refunded_paise?: number;
      }>(`/bookings/${id}/cancel`, { method: 'POST', body: { reason, cancel_item_ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.myBookings }),
  });
}

// ------------------------------------------------------------------ partner
export function usePartnerDashboard(period: 'TODAY' | 'WEEK' | 'MONTH' = 'MONTH', enabled = true) {
  return useQuery({
    queryKey: qk.dashboard(period),
    queryFn: () =>
      api<{
        period: string;
        revenue_paise: number;
        completed_visits: number;
        completed_services: number;
        avg_bill_paise: number;
        returning_customers: number;
        new_customers: number;
        retention_rate_pct: number;
        reminder_conversion_rate_pct: number;
        revenue_by_staff: { staff_name: string; revenue_paise: number }[];
      }>(`/partner/dashboard?period=${period}`),
    enabled,
  });
}

export function usePartnerBookings(date: string, enabled = true) {
  return useQuery({
    queryKey: qk.partnerBookings(date),
    queryFn: () => api<{ date: string; bookings: PartnerBooking[] }>(`/partner/bookings?date=${date}`),
    enabled,
  });
}

export function usePartnerServices(enabled = true) {
  return useQuery({
    queryKey: qk.partnerServices,
    queryFn: () => api<{ services: SalonService[] }>('/partner/services'),
    enabled,
  });
}

export function usePartnerStaff(enabled = true) {
  return useQuery({
    queryKey: qk.partnerStaff,
    queryFn: () => api<{ staff: (SalonStaff & { working_days: number[]; is_active: boolean })[] }>('/partner/staff'),
    enabled,
  });
}

export interface CrmCustomer {
  id: string;
  salon_id: string;
  customer_id: string;
  customer_name: string;
  custom_customer_code: string;
  preferred_staff_id: string | null;
  total_visits: number;
  total_spend_paise: number;
  avg_bill_paise: number;
  computed_visit_interval_days: number;
  retention_segment: 'NEW' | 'REGULAR' | 'AT_RISK' | 'INACTIVE';
  last_visit_at: string;
  next_expected_visit_date: string | null;
  loyalty_points_balance: number;
}

export function usePartnerCrm(enabled = true) {
  return useQuery({
    queryKey: qk.partnerCrm,
    queryFn: () => api<{ customers: CrmCustomer[] }>('/partner/crm'),
    enabled,
  });
}

export function usePartnerCrmDetail(customerId?: string) {
  return useQuery({
    queryKey: qk.partnerCrmDetail(customerId ?? ''),
    queryFn: () =>
      api<{
        crm: CrmCustomer;
        visits: { id: string; booking_code: string; status: string; scheduled_start_at: string; total_payable_paise: number }[];
        ledger: {
          id: string;
          entry_type: string;
          bucket: string;
          amount_delta: number;
          balance_after: number;
          created_at: string;
        }[];
      }>(`/partner/crm/${customerId}`),
    enabled: !!customerId,
  });
}

export function useUpdateCrm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, ...body }: { customerId: string; retention_segment?: CrmCustomer['retention_segment']; custom_customer_code?: string }) =>
      api(`/partner/crm/${customerId}`, { method: 'PATCH', body }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.partnerCrm });
      qc.invalidateQueries({ queryKey: qk.partnerCrmDetail(vars.customerId) });
    },
  });
}

export function usePartnerReviews(enabled = true) {
  return useQuery({
    queryKey: qk.partnerReviews,
    queryFn: () =>
      api<{
        open_alerts: number;
        reviews: {
          id: string;
          booking_id: string;
          overall_rating: number;
          hygiene_rating: number;
          review_text: string | null;
          owner_reply: string | null;
          resolution_status: string;
          created_at: string;
          customer_name: string;
          staff_name: string | null;
        }[];
      }>('/partner/reviews'),
    enabled,
  });
}

export function useReplyReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, owner_reply, resolution_status }: { id: string; owner_reply: string; resolution_status?: string }) =>
      api(`/partner/reviews/${id}/reply`, { method: 'POST', body: { owner_reply, resolution_status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.partnerReviews }),
  });
}

export function usePartnerResources(enabled = true) {
  return useQuery({
    queryKey: qk.partnerResources,
    queryFn: () =>
      api<{ resources: { id: string; name: string; resource_type: string }[] }>('/partner/resources'),
    enabled,
  });
}

export function useCreateResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; resource_type: string }) =>
      api('/partner/resources', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.partnerResources }),
  });
}

export function useTriggerReminders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      customer_ids: string[];
      channel: 'WHATSAPP' | 'SMS' | 'PUSH' | 'EMAIL';
      template_code: string;
    }) =>
      api<{ enqueued: number; skipped: number; sent: number; failed: number }>('/partner/reminders/trigger', {
        method: 'POST',
        body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.partnerReminders }),
  });
}

export function useDispatchReminders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reminder_ids?: string[]; limit?: number } = {}) =>
      api<{ due: number; sent: number; suppressed: number; failed: number; skipped: number }>(
        '/partner/reminders/dispatch',
        { method: 'POST', body },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.partnerReminders }),
  });
}

export function useSubmitReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      bookingId,
      ...body
    }: {
      bookingId: string;
      overall_rating: number;
      hygiene_rating: number;
      review_text?: string;
    }) => api(`/bookings/${bookingId}/reviews`, { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.myBookings });
      qc.invalidateQueries({ queryKey: ['salon'] });
    },
  });
}

export function usePartnerReminders(enabled = true) {
  return useQuery({
    queryKey: qk.partnerReminders,
    queryFn: () =>
      api<{ summary: { sent: number; delivered: number; clicked: number; converted_bookings: number; conversion_rate_pct: number }; reminders: any[] }>(
        '/partner/reminders',
      ),
    enabled,
  });
}

export function usePartnerQueue(enabled = true) {
  return useQuery({
    queryKey: qk.partnerQueue,
    queryFn: () => api<{ now_serving_token: number | null; waiting_count: number; queue: any[]; walkin_paused: boolean }>('/partner/queue'),
    enabled,
  });
}

export function useLiveQueue(salonId: string, enabled = true) {
  return useQuery({
    queryKey: ['queue', 'live', salonId],
    queryFn: () =>
      api<{
        walkin_paused: boolean;
        now_serving_token: number | null;
        waiting_count: number;
        queue: {
          token_number: number;
          customer_name: string;
          status: string;
          estimated_wait_mins: number;
        }[];
      }>(`/queue/${salonId}/live`),
    enabled: enabled && !!salonId,
    refetchInterval: 10_000,
  });
}

export function useQueueToken(salonId: string, tokenId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['queue', 'token', salonId, tokenId],
    queryFn: () =>
      api<{
        token_id: string;
        token_number: number;
        status: string;
        customer_name: string;
        queue_date: string;
        people_ahead: number;
        estimated_wait_mins: number;
        assigned_staff_id?: string;
        assigned_resource_id?: string;
        total_duration_mins: number;
        joined_at: string;
        called_at?: string;
        service_started_at?: string;
        completed_at?: string;
      }>(`/queue/${salonId}/tokens/${tokenId}`),
    enabled: enabled && !!salonId && !!tokenId,
    refetchInterval: 5_000,
  });
}

export function useJoinQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      salon_id: string;
      customer_name?: string;
      phone?: string;
      service_ids: string[];
      preferred_staff_id?: string;
    }) =>
      api<{
        token_id: string;
        token_number: number;
        status: string;
        people_ahead: number;
        estimated_wait_mins: number;
        is_estimate_disclaimer?: boolean;
      }>('/queue/join', { method: 'POST', body }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['queue', 'live', vars.salon_id] });
      qc.invalidateQueries({ queryKey: ['salons'] });
    },
  });
}

export function useLeaveQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ salonId, tokenId }: { salonId: string; tokenId: string }) =>
      api(`/queue/${salonId}/tokens/${tokenId}`, { method: 'PATCH', body: { status: 'LEFT_QUEUE' } }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['queue', 'live', vars.salonId] });
      qc.invalidateQueries({ queryKey: ['queue', 'token', vars.salonId, vars.tokenId] });
    },
  });
}

export function usePartnerInvoices(enabled = true) {
  return useQuery({
    queryKey: qk.partnerInvoices,
    queryFn: () => api<{ totals: any; invoices: any[] }>('/partner/invoices'),
    enabled,
  });
}

export function useUpdateBookingStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/bookings/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partner'] });
      qc.invalidateQueries({ queryKey: qk.myBookings });
    },
  });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, method }: { bookingId: string; method: string }) =>
      api<{ invoice_number: string; net_collected_paise: number }>('/partner/invoices', {
        method: 'POST',
        key: crypto.randomUUID(),
        body: { booking_id: bookingId, method },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner'] }),
  });
}

export function useCreateService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      category_id: string;
      custom_name: string;
      base_price_paise: number;
      duration_mins: number;
      buffer_after_mins?: number;
    }) => api('/partner/services', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.partnerServices }),
  });
}

export function useToggleService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api(`/partner/services/${id}`, { method: 'PATCH', body: { is_active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.partnerServices }),
  });
}

export function useCreateStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { display_name: string; specialization?: string; experience_years?: number }) =>
      api('/partner/staff', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.partnerStaff }),
  });
}

export function useUpdatePartnerBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/bookings/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner'] }),
  });
}

export function useSetSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ staffId, entries }: { staffId: string; entries: unknown[] }) =>
      api(`/partner/staff/${staffId}/schedule`, { method: 'POST', body: { entries } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.partnerStaff }),
  });
}

export function useAddStaffBreak() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      staffId,
      date,
      start_time,
      end_time,
      reason,
    }: {
      staffId: string;
      date: string;
      start_time: string;
      end_time: string;
      reason?: string;
    }) =>
      api<{ ok: boolean; staff_id: string; date: string; break: { start: string; end: string; reason: string } }>(
        `/partner/staff/${staffId}/breaks`,
        { method: 'POST', body: { date, start_time, end_time, reason } },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.partnerStaff });
      qc.invalidateQueries({ queryKey: ['availability'] });
    },
  });
}

// ------------------------------------------------------------------ multi-salon
export interface PartnerSalonSummary {
  id: string;
  name: string;
  slug: string;
  city: string;
  locality: string;
  verification_status: string;
  is_active: boolean;
  avg_rating: number;
  review_count: number;
  upcoming_bookings: number;
}

export function usePartnerSalons(enabled = true) {
  return useQuery({
    queryKey: ['partner', 'salons'],
    queryFn: () => api<{ salons: PartnerSalonSummary[]; active_salon_id: string }>('/partner/salons'),
    enabled,
  });
}

// ------------------------------------------------------------------ engagement
export interface ReminderFunnel {
  scheduled: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  converted: number;
  suppressed: number;
  failed: number;
}

export function useReminderFunnel(enabled = true) {
  return useQuery({
    queryKey: ['partner', 'reminders', 'analytics'],
    queryFn: () => api<{ funnel: ReminderFunnel }>('/partner/reminders/analytics'),
    enabled,
  });
}

// ------------------------------------------------------------------ payments
export function usePaymentCapabilities() {
  return useQuery({
    queryKey: ['payments', 'capabilities'],
    queryFn: () =>
      api<{ provider: string; online: boolean; manual: boolean; configured: boolean }>('/payments/capabilities'),
    staleTime: 5 * 60_000,
  });
}

export interface PaymentIntent {
  payment_id: string;
  provider: string;
  status: string;
  amount_paise: number;
  currency: string;
  booking_id: string | null;
  invoice_id: string | null;
  instructions?: string;
  key_id?: string;
  order_id?: string;
  checkout?: { provider: string; key: string; order_id: string; amount: number; currency: string };
}

export function useCreatePaymentIntent() {
  return useMutation({
    mutationFn: (body: { booking_id?: string; invoice_id?: string; amount_paise?: number }) =>
      api<PaymentIntent>('/payments/intents', { method: 'POST', body, key: crypto.randomUUID() }),
  });
}

export function useVerifyPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      paymentId,
      ...body
    }: {
      paymentId: string;
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
    }) => api(`/payments/${paymentId}/verify`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payments'] }),
  });
}

export function usePayments(enabled = true) {
  return useQuery({
    queryKey: ['payments', 'mine'],
    queryFn: () => api<{ payments: any[] }>('/payments'),
    enabled,
  });
}

export function usePartnerPayments(enabled = true) {
  return useQuery({
    queryKey: ['partner', 'payments'],
    queryFn: () => api<{ payments: any[] }>('/partner/payments'),
    enabled,
  });
}

export function useRefundPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount_paise, reason }: { id: string; amount_paise?: number; reason?: string }) =>
      api(`/partner/payments/${id}/refund`, { method: 'POST', body: { amount_paise, reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner'] }),
  });
}

export function usePartnerSettlements(from?: string, to?: string, enabled = true) {
  return useQuery({
    queryKey: ['partner', 'settlements', from, to],
    queryFn: () =>
      api<{
        days: { settlement_date: string; invoices: number; gross_paise: number; commission_paise: number; partner_paise: number }[];
        totals: { gross_paise: number; commission_paise: number; partner_paise: number; invoices: number };
        note: string;
      }>(`/partner/settlements${qs({ from, to })}`),
    enabled,
  });
}

// ------------------------------------------------------------------ uploads
export interface PresignResult {
  upload_url: string;
  method: 'PUT';
  key: string;
  expires_in: number;
  public_url: string | null;
  headers: Record<string, string>;
  content_type: string;
  purpose: string;
}

export function usePresignUpload() {
  return useMutation({
    mutationFn: (body: { purpose: 'avatar' | 'kyc_document' | 'style_photo'; content_type: string; salon_id?: string }) =>
      api<PresignResult>('/uploads/presign', { method: 'POST', body }),
  });
}

/** Presign, PUT the bytes straight to object storage, then return the stored key. */
export async function uploadFile(
  file: File,
  purpose: 'avatar' | 'kyc_document' | 'style_photo',
  salonId?: string,
): Promise<PresignResult> {
  const contentType = file.type || 'application/octet-stream';
  const presigned = await api<PresignResult>('/uploads/presign', {
    method: 'POST',
    body: { purpose, content_type: contentType, salon_id: salonId },
  });
  const res = await fetch(presigned.upload_url, {
    method: presigned.method,
    headers: { 'Content-Type': contentType, ...presigned.headers },
    body: file,
  });
  if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', `Storage rejected the upload (${res.status})`);
  return presigned;
}

export function useUploadStatus() {
  return useQuery({
    queryKey: ['uploads', 'status'],
    queryFn: () =>
      api<{ provider: string; configured: boolean; allowed_content_types: string[]; note: string }>('/uploads/status'),
    staleTime: 5 * 60_000,
  });
}

// ------------------------------------------------------------------ customer account
export interface MyProfile {
  id: string;
  full_name: string;
  email: string | null;
  role: string;
  status: string;
  gender: string | null;
  date_of_birth: string | null;
  avatar_s3_key: string | null;
  phone: string;
  phone_masked: string;
  emergency_contacts_json: any[];
}

export function useMe(enabled = true) {
  return useQuery({ queryKey: ['me'], queryFn: () => api<MyProfile>('/auth/me'), enabled });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<MyProfile, 'full_name' | 'email' | 'gender' | 'date_of_birth'>>) =>
      api('/users/me', { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export interface Consent {
  id?: string;
  salon_id: string | null;
  channel: 'WHATSAPP' | 'SMS' | 'PUSH' | 'EMAIL';
  purpose: 'BOOKING_TRANSACTIONAL' | 'RETENTION_REMINDER' | 'PROMOTIONAL_OFFERS' | 'STYLE_PHOTO_STORAGE';
  is_granted: boolean;
  updated_at?: string;
}

export function useConsents(enabled = true) {
  return useQuery({
    queryKey: ['me', 'consents'],
    queryFn: () => api<{ consents: Consent[] }>('/users/me/consents'),
    enabled,
  });
}

export function useSetConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { channel: Consent['channel']; purpose: Consent['purpose']; is_granted: boolean; salon_id?: string }) =>
      api('/users/me/consents', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'consents'] }),
  });
}

export interface Address {
  id: string;
  label: string;
  address_line?: string;
  locality: string;
  city: string;
  postal_code: string;
  is_default: boolean;
  lat: number;
  lng: number;
}

export function useAddresses(enabled = true) {
  return useQuery({
    queryKey: ['me', 'addresses'],
    queryFn: () => api<{ addresses: Address[] }>('/users/me/addresses'),
    enabled,
  });
}

export function useAddAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      label: string;
      address_line: string;
      locality: string;
      city: string;
      postal_code: string;
      lat: number;
      lng: number;
      is_default?: boolean;
    }) => api('/users/me/addresses', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'addresses'] }),
  });
}

export function useDeleteAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/users/me/addresses/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'addresses'] }),
  });
}

export function useUpdateAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<Omit<Address, 'id'>>) =>
      api(`/users/me/addresses/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'addresses'] }),
  });
}

export function useDeleteAccount() {
  return useMutation({
    mutationFn: () =>
      api<{ status: string; purge_eta_hrs: number }>('/users/me/privacy/delete', {
        method: 'POST',
        body: { confirmation: 'DELETE_MY_ACCOUNT' },
      }),
  });
}

export function useSetAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (avatar_s3_key: string | null) =>
      api('/users/me/avatar', { method: 'PATCH', body: { avatar_s3_key } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

// ------------------------------------------------------------------ onboarding / KYC
export interface PartnerSalon {
  id: string;
  name: string;
  description: string | null;
  verification_status: string;
  address_line: string;
  locality: string;
  city: string;
  state: string;
  postal_code: string;
  operating_hours: Record<string, { open: string | null; close: string | null }>;
  hygiene_facilities?: Record<string, boolean> | null;
  kyc?: {
    id: string;
    gstin: string | null;
    bank_ifsc: string;
    shop_license_s3_key: string | null;
    status: string;
    rejection_reason: string | null;
  } | null;
}

export function usePartnerSalon(enabled = true) {
  return useQuery({
    queryKey: ['partner', 'salon'],
    queryFn: () => api<PartnerSalon>('/partner/salon'),
    enabled,
  });
}

export function useCreateSalon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PartnerSalon>('/partner/salons', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner'] }),
  });
}

export function usePatchSalon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/partner/salon', { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner', 'salon'] }),
  });
}

export function useSubmitSalon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/partner/salon/submit', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner'] }),
  });
}

export function useSubmitKyc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { pan_number: string; gstin?: string; bank_account_number: string; bank_ifsc: string; shop_license_s3_key?: string }) =>
      api('/partner/kyc', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner', 'salon'] }),
  });
}

// ------------------------------------------------------------------ platform admin
export function useAdminStats(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () =>
      api<{
        salons: { total: number; approved: number; pending: number };
        users: { total: number; customers: number };
        gmv: { gmv: string; commission: string };
      }>('/admin/stats'),
    enabled,
  });
}

export function useAdminKyc(status?: string, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'kyc', status ?? 'all'],
    queryFn: () => api<{ submissions: any[] }>(`/admin/kyc${qs({ status })}`),
    enabled,
  });
}

export function useReviewKyc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ salonId, decision, rejection_reason }: { salonId: string; decision: 'APPROVED' | 'REJECTED' | 'UNDER_REVIEW'; rejection_reason?: string }) =>
      api(`/admin/kyc/${salonId}/review`, { method: 'POST', body: { decision, rejection_reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}

export function useAdminSalons(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'salons'],
    queryFn: () => api<{ salons: any[] }>('/admin/salons'),
    enabled,
  });
}

export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<{ users: any[] }>('/admin/users'),
    enabled,
  });
}

export function useUpdateCommission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ salonId, ...body }: { salonId: string } & Record<string, unknown>) =>
      api(`/admin/salons/${salonId}/commission`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}
