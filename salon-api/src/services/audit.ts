import { query } from '../db.js';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: string | null;
  salonId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Append an audit entry. Auditing must never break the action it describes,
 * so failures are logged and swallowed.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log
         (actor_id, actor_role, salon_id, action, entity_type, entity_id, metadata, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        input.actorId ?? null,
        input.actorRole ?? null,
        input.salonId ?? null,
        input.action,
        input.entityType,
        input.entityId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.ip ?? null,
      ],
    );
  } catch (err) {
    console.warn('[audit] failed to record event', input.action, err instanceof Error ? err.message : err);
  }
}

export interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  actor_name: string | null;
  salon_id: string | null;
  salon_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function listAudit(opts: {
  limit?: number;
  action?: string;
  salonId?: string;
}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  return query<AuditRow>(
    `SELECT a.id, a.actor_id, a.actor_role, u.full_name AS actor_name,
            a.salon_id, s.name AS salon_name, a.action, a.entity_type, a.entity_id,
            a.metadata, a.created_at
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN salons s ON s.id = a.salon_id
      WHERE ($1::text IS NULL OR a.action = $1)
        AND ($2::uuid IS NULL OR a.salon_id = $2)
      ORDER BY a.created_at DESC
      LIMIT $3`,
    [opts.action ?? null, opts.salonId ?? null, limit],
  );
}
