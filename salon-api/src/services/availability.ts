import { one, query } from '../db.js';
import { badRequest, conflict, notFound } from '../http.js';
import { redis } from '../redis.js';

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const SLOT_STEP_MINS = 15;

export interface ServiceRow {
  id: string;
  custom_name: string;
  base_price_paise: number;
  discounted_price_paise: number | null;
  duration_mins: number;
  buffer_after_mins: number;
  requires_resource_type: string | null;
  category_id: string;
}

export interface AvailabilitySlot {
  start: string;
  end: string;
  start_at: string;
  end_at: string;
  staff_id: string;
  resource_id: string | null;
  instant_confirm: boolean;
}

export interface AvailabilityResult {
  date: string;
  total_duration_mins: number;
  slots: AvailabilitySlot[];
}

export function parseDay(dateISO: string): { dayStartUtc: Date; dayOfWeek: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw badRequest('VALIDATION_ERROR', 'date must be YYYY-MM-DD');
  return {
    dayStartUtc: new Date(`${dateISO}T00:00:00+05:30`),
    dayOfWeek: new Date(`${dateISO}T00:00:00Z`).getUTCDay(),
  };
}

export function atTime(dayStartUtc: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(dayStartUtc.getTime() + (h * 60 + m) * 60_000);
}

export function fmtLocalTime(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
}

export function fmtLocalDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export async function getSalonOrThrow(salonId: string) {
  const salon = await one(`SELECT * FROM salons WHERE id = $1`, [salonId]);
  if (!salon) throw notFound('Salon not found');
  return salon;
}

export async function loadServices(salonId: string, serviceIds: string[]): Promise<ServiceRow[]> {
  if (!serviceIds.length) throw badRequest('VALIDATION_ERROR', 'At least one service is required');
  const services = await query<ServiceRow>(
    `SELECT id, custom_name, base_price_paise, discounted_price_paise, duration_mins,
            buffer_after_mins, requires_resource_type, category_id
       FROM salon_services
      WHERE salon_id = $1 AND id = ANY($2::uuid[]) AND is_active = TRUE`,
    [salonId, serviceIds],
  );
  if (services.length !== serviceIds.length) {
    throw badRequest('INVALID_SERVICE', 'One or more services are invalid for this salon');
  }
  return services;
}

export function priceOf(service: ServiceRow): number {
  return service.discounted_price_paise ?? service.base_price_paise;
}

export function totalDuration(services: ServiceRow[]): number {
  return services.reduce((sum, s) => sum + s.duration_mins + s.buffer_after_mins, 0);
}

async function qualifiedStaff(salonId: string, serviceIds: string[]): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT s.id
       FROM staff_members s
       JOIN staff_service_mapping m ON m.staff_id = s.id
      WHERE s.salon_id = $1 AND s.is_active = TRUE
        AND m.salon_service_id = ANY($2::uuid[])
      GROUP BY s.id
     HAVING COUNT(DISTINCT m.salon_service_id) = $3`,
    [salonId, serviceIds, serviceIds.length],
  );
  return rows.map((r) => r.id);
}

async function staffSchedule(staffId: string, dayISO: string, dayOfWeek: number) {
  const override = await one(
    `SELECT * FROM staff_schedules WHERE staff_id = $1 AND override_date = $2 LIMIT 1`,
    [staffId, dayISO],
  );
  if (override) return override;
  return one(
    `SELECT * FROM staff_schedules
      WHERE staff_id = $1 AND override_date IS NULL AND day_of_week = $2
      LIMIT 1`,
    [staffId, dayOfWeek],
  );
}

export async function computeAvailability(opts: {
  salonId: string;
  serviceIds: string[];
  dateISO: string;
  staffId?: string;
}): Promise<AvailabilityResult> {
  const salon = await getSalonOrThrow(opts.salonId);
  const services = await loadServices(opts.salonId, opts.serviceIds);
  const duration = totalDuration(services);
  const { dayStartUtc, dayOfWeek } = parseDay(opts.dateISO);

  let staffIds: string[];
  if (opts.staffId) {
    const eligible = await qualifiedStaff(opts.salonId, opts.serviceIds);
    if (!eligible.includes(opts.staffId)) {
      throw badRequest('STAFF_NOT_QUALIFIED', 'Selected staff cannot perform all requested services');
    }
    staffIds = [opts.staffId];
  } else {
    staffIds = await qualifiedStaff(opts.salonId, opts.serviceIds);
  }

  const requiredTypes = Array.from(
    new Set(services.map((s) => s.requires_resource_type).filter((t): t is string => !!t)),
  );

  const slots: AvailabilitySlot[] = [];
  const dayEnd = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);

  for (const staffId of staffIds) {
    const schedule = await staffSchedule(staffId, opts.dateISO, dayOfWeek);
    if (!schedule || schedule.is_working_day === false) continue;

    const shiftStart = atTime(dayStartUtc, String(schedule.shift_start).slice(0, 5));
    const shiftEnd = atTime(dayStartUtc, String(schedule.shift_end).slice(0, 5));

    const breaks = (Array.isArray(schedule.breaks_json) ? schedule.breaks_json : []).map((b: any) => ({
      start: atTime(dayStartUtc, b.start).getTime(),
      end: atTime(dayStartUtc, b.end).getTime(),
    }));

    const booked = await query<{ start: string; end: string }>(
      `SELECT lower(time_range) AS start, upper(time_range) AS end
         FROM booking_items
        WHERE staff_id = $1
          AND status IN ('CONFIRMED', 'ARRIVED', 'IN_SERVICE')
          AND time_range && tstzrange($2, $3, '[)')`,
      [staffId, dayStartUtc, dayEnd],
    );
    const bookedRanges = booked.map((b) => ({
      start: new Date(b.start).getTime(),
      end: new Date(b.end).getTime(),
    }));

    const walkins = await query<{ start: string; duration: number }>(
      `SELECT COALESCE(service_started_at, called_at, NOW()) AS start, total_duration_mins AS duration
         FROM walkin_queue_tokens
        WHERE assigned_staff_id = $1
          AND queue_date = $2
          AND status IN ('CALLED', 'IN_SERVICE')`,
      [staffId, opts.dateISO],
    );
    for (const w of walkins) {
      const start = new Date(w.start).getTime();
      const end = start + Math.max(15, w.duration || 15) * 60_000;
      bookedRanges.push({ start, end });
    }

    let resources: { id: string; resource_type: string }[] = [];
    let resourceBooked: { resource_id: string; start: number; end: number }[] = [];
    if (requiredTypes.length) {
      resources = await query<{ id: string; resource_type: string }>(
        `SELECT id, resource_type FROM salon_resources
          WHERE salon_id = $1 AND is_active = TRUE AND resource_type = ANY($2::text[])`,
        [opts.salonId, requiredTypes],
      );
      const rb = await query<{ resource_id: string; start: string; end: string }>(
        `SELECT resource_id, lower(time_range) AS start, upper(time_range) AS end
           FROM booking_items
          WHERE resource_id IS NOT NULL
            AND status IN ('CONFIRMED', 'ARRIVED', 'IN_SERVICE')
            AND time_range && tstzrange($1, $2, '[)')`,
        [dayStartUtc, dayEnd],
      );
      resourceBooked = rb.map((r) => ({
        resource_id: r.resource_id,
        start: new Date(r.start).getTime(),
        end: new Date(r.end).getTime(),
      }));

      const walkinResources = await query<{ resource_id: string; start: string; duration: number }>(
        `SELECT assigned_resource_id AS resource_id, COALESCE(service_started_at, called_at, NOW()) AS start, total_duration_mins AS duration
           FROM walkin_queue_tokens
          WHERE salon_id = $1
            AND queue_date = $2
            AND assigned_resource_id IS NOT NULL
            AND status IN ('CALLED', 'IN_SERVICE')`,
        [opts.salonId, opts.dateISO],
      );
      for (const wr of walkinResources) {
        const start = new Date(wr.start).getTime();
        const end = start + Math.max(15, wr.duration || 15) * 60_000;
        resourceBooked.push({ resource_id: wr.resource_id, start, end });
      }
    }

    const stepMs = SLOT_STEP_MINS * 60_000;
    const durationMs = duration * 60_000;

    for (let start = shiftStart.getTime(); start + durationMs <= shiftEnd.getTime(); start += stepMs) {
      const end = start + durationMs;
      if (breaks.some((b) => overlaps(start, end, b.start, b.end))) continue;
      if (bookedRanges.some((b) => overlaps(start, end, b.start, b.end))) continue;

      let resourceId: string | null = null;
      if (requiredTypes.length) {
        const free = resources.find(
          (r) =>
            requiredTypes.includes(r.resource_type) &&
            !resourceBooked.some(
              (rb) => rb.resource_id === r.id && overlaps(start, end, rb.start, rb.end),
            ),
        );
        if (!free) continue;
        resourceId = free.id;
      }

      slots.push({
        start: fmtLocalTime(new Date(start)),
        end: fmtLocalTime(new Date(end)),
        start_at: new Date(start).toISOString(),
        end_at: new Date(end).toISOString(),
        staff_id: staffId,
        resource_id: resourceId,
        instant_confirm: salon.accepts_instant_booking === true,
      });
    }
  }

  slots.sort((a, b) => a.start_at.localeCompare(b.start_at));
  void syncSalonAvailabilityBitmap(opts.salonId, opts.dateISO, slots).catch(() => {});
  return { date: opts.dateISO, total_duration_mins: duration, slots };
}

export async function syncSalonAvailabilityBitmap(
  salonId: string,
  dateISO: string,
  slots: { start_at: string }[],
): Promise<void> {
  const key = `avail:bitmap:${salonId}:${dateISO}`;
  const dayStartUtc = new Date(`${dateISO}T00:00:00+05:30`).getTime();
  const pipe = redis.pipeline();
  pipe.del(key);
  const seenBits = new Set<number>();
  for (const slot of slots) {
    const t = new Date(slot.start_at).getTime();
    const bit = Math.floor((t - dayStartUtc) / (15 * 60_000));
    if (bit >= 0 && bit < 96 && !seenBits.has(bit)) {
      seenBits.add(bit);
      pipe.setbit(key, bit, 1);
    }
  }
  pipe.expire(key, 300); // 5 min TTL
  await pipe.exec().catch(() => {});
}

export async function hasSlotsInWindowBitmap(
  salonId: string,
  dateISO: string,
  startMs: number,
  endMs: number,
): Promise<boolean | null> {
  const key = `avail:bitmap:${salonId}:${dateISO}`;
  const exists = await redis.exists(key);
  if (!exists) return null; // Cache miss; need full compute

  const dayStartUtc = new Date(`${dateISO}T00:00:00+05:30`).getTime();
  const minBit = Math.max(0, Math.floor((startMs - dayStartUtc) / (15 * 60_000)));
  const maxBit = Math.min(95, Math.floor((endMs - dayStartUtc) / (15 * 60_000)));
  if (minBit > maxBit) return false;

  const pipe = redis.pipeline();
  for (let bit = minBit; bit <= maxBit; bit++) {
    pipe.getbit(key, bit);
  }
  const results = await pipe.exec();
  if (!results) return null;
  return results.some(([_, val]) => Number(val) === 1);
}

export async function nextAvailableSlot(salonId: string): Promise<string | null> {
  const cacheKey = `salon:next_slot:${salonId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached !== null) return cached === 'none' ? null : cached;

  const service = await one<{ id: string }>(
    `SELECT id FROM salon_services WHERE salon_id = $1 AND is_active = TRUE ORDER BY duration_mins LIMIT 1`,
    [salonId],
  );
  if (!service) {
    await redis.set(cacheKey, 'none', 'EX', 180).catch(() => {});
    return null;
  }
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86_400_000 + IST_OFFSET_MS);
    const dateISO = d.toISOString().slice(0, 10);
    const result = await computeAvailability({ salonId, serviceIds: [service.id], dateISO });
    if (result.slots.length) {
      const slot = result.slots[0].start_at;
      await redis.set(cacheKey, slot, 'EX', 180).catch(() => {});
      return slot;
    }
  }
  await redis.set(cacheKey, 'none', 'EX', 180).catch(() => {});
  return null;
}

export async function assertSlotAvailable(salonId: string, serviceIds: string[], startAt: string, staffId?: string) {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw badRequest('VALIDATION_ERROR', 'start_at must be a valid ISO timestamp');
  const dateISO = fmtLocalDate(start);
  const availability = await computeAvailability({ salonId, serviceIds, dateISO, staffId });
  const wanted = fmtLocalTime(start);
  const match = availability.slots.find(
    (s) => s.start === wanted && (!staffId || s.staff_id === staffId),
  );
  if (!match) throw conflict('SLOT_UNAVAILABLE', 'The requested slot is no longer available');
  return { match, availability };
}
