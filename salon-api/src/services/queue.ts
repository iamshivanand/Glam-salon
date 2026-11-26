import type pg from 'pg';
import { one, query, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../http.js';
import { loadServices } from './availability.js';
import { fmtLocalDate } from './availability.js';
import { queueTransactional } from './transactional.js';
import { redis } from '../redis.js';

const AVG_SERVICE_MINS = 15;

export async function joinQueue(opts: {
  salonId: string;
  customerId?: string | null;
  customerName: string;
  phoneEncrypted?: Buffer | null;
  phoneBlindIndex?: string | null;
  serviceIds: string[];
  preferredStaffId?: string;
}) {
  const salon = await one(`SELECT * FROM salons WHERE id = $1`, [opts.salonId]);
  if (!salon) throw notFound('Salon not found');
  if (salon.walkin_paused) throw conflict('QUEUE_PAUSED_BY_SALON', 'This salon has paused remote walk-ins');
  if (!salon.accepts_walkins) throw conflict('WALKINS_DISABLED', 'This salon does not accept walk-ins');

  const services = await loadServices(opts.salonId, opts.serviceIds);
  const totalDuration = services.reduce((s, x) => s + x.duration_mins, 0);
  const queueDate = fmtLocalDate(new Date());

  const result = await tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`queue:${opts.salonId}:${queueDate}`]);
    const ahead = await client.query<{ n: string; active: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'WAITING')::int AS n,
         COUNT(*) FILTER (WHERE status IN ('CALLED','IN_SERVICE'))::int AS active
       FROM walkin_queue_tokens WHERE salon_id = $1 AND queue_date = $2`,
      [opts.salonId, queueDate],
    );
    const peopleAhead = Number(ahead.rows[0]?.n ?? 0);
    const active = Number(ahead.rows[0]?.active ?? 0);
    const estimated = peopleAhead * AVG_SERVICE_MINS + active * AVG_SERVICE_MINS;

    const next = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(token_number), 0) + 1 AS next
         FROM walkin_queue_tokens WHERE salon_id = $1 AND queue_date = $2`,
      [opts.salonId, queueDate],
    );
    const tokenNumber = Number(next.rows[0]?.next ?? 1);

    const inserted = await client.query(
      `INSERT INTO walkin_queue_tokens
         (salon_id, customer_id, walkin_customer_name, walkin_phone_encrypted, walkin_phone_blind_index,
          preferred_staff_id, selected_service_ids, total_duration_mins, queue_date, token_number,
          status, estimated_wait_mins)
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10,'WAITING',$11)
       RETURNING *`,
      [
        opts.salonId,
        opts.customerId ?? null,
        opts.customerName,
        opts.phoneEncrypted ?? null,
        opts.phoneBlindIndex ?? null,
        opts.preferredStaffId ?? null,
        opts.serviceIds,
        totalDuration,
        queueDate,
        tokenNumber,
        estimated,
      ],
    );

    return {
      token_id: inserted.rows[0].id,
      token_number: tokenNumber,
      status: 'WAITING',
      people_ahead: peopleAhead,
      estimated_wait_mins: estimated,
      is_estimate_disclaimer: true,
    };
  });

  const seqKey = `queue:seq:${opts.salonId}:${queueDate}`;
  await redis.set(seqKey, String(result.token_number), 'EX', 86400 * 2).catch(() => {});
  await redis.zadd(`queue:active:${opts.salonId}`, result.token_number, result.token_id).catch(() => {});
  await redis.expire(`queue:active:${opts.salonId}`, 86400 * 2).catch(() => {});

  // Broadcast live queue snapshot over Redis Pub/Sub
  void liveQueue(opts.salonId).then((snapshot) => {
    return redis.publish(`pubsub:queue:${opts.salonId}`, JSON.stringify(snapshot));
  }).catch(() => {});

  if (opts.customerId) {
    queueTransactional({
      template: 'QUEUE_JOINED',
      userId: opts.customerId,
      salonId: opts.salonId,
      context: {
        customerName: opts.customerName,
        salonName: salon.name,
        tokenNumber: result.token_number,
      },
      data: { queue_token_id: result.token_id },
    });
  }
  return result;
}

export async function liveQueue(salonId: string) {
  const salon = await one(`SELECT id, walkin_paused, accepts_walkins FROM salons WHERE id = $1`, [salonId]);
  if (!salon) throw notFound('Salon not found');
  const queueDate = fmtLocalDate(new Date());

  const tokens = await query(
    `SELECT token_number, walkin_customer_name AS customer_name, status, estimated_wait_mins,
            assigned_staff_id, joined_at, called_at, service_started_at
       FROM walkin_queue_tokens
      WHERE salon_id = $1 AND queue_date = $2
        AND status NOT IN ('COMPLETED','SKIPPED','LEFT_QUEUE')
      ORDER BY token_number`,
    [salonId, queueDate],
  );

  const nowServing = tokens.find((t) => t.status === 'IN_SERVICE') ?? tokens.find((t) => t.status === 'CALLED');
  const waiting = tokens.filter((t) => t.status === 'WAITING');

  return {
    walkin_paused: salon.walkin_paused,
    now_serving_token: nowServing?.token_number ?? null,
    waiting_count: waiting.length,
    queue: tokens.map((t) => ({
      token_number: t.token_number,
      customer_name: t.customer_name,
      status: t.status,
      estimated_wait_mins: t.status === 'IN_SERVICE' ? 0 : t.estimated_wait_mins,
    })),
  };
}

export async function updateQueueStatus(opts: {
  salonId: string;
  tokenId: string;
  status: string;
  assignedStaffId?: string;
  assignedResourceId?: string;
}) {
  const allowed = ['WAITING', 'CALLED', 'IN_SERVICE', 'COMPLETED', 'SKIPPED', 'LEFT_QUEUE'];
  if (!allowed.includes(opts.status)) throw badRequest('VALIDATION_ERROR', 'Invalid queue status');

  const updated = await tx(async (client) => {
    const token = (
      await client.query(`SELECT * FROM walkin_queue_tokens WHERE id = $1 AND salon_id = $2 FOR UPDATE`, [
        opts.tokenId,
        opts.salonId,
      ])
    ).rows[0];
    if (!token) throw notFound('Queue token not found');

    await client.query(
      `UPDATE walkin_queue_tokens
          SET status = $2,
              assigned_staff_id = COALESCE($3, assigned_staff_id),
              assigned_resource_id = COALESCE($4, assigned_resource_id),
              called_at = CASE WHEN $2 = 'CALLED' THEN NOW() ELSE called_at END,
              service_started_at = CASE WHEN $2 = 'IN_SERVICE' THEN NOW() ELSE service_started_at END,
              completed_at = CASE WHEN $2 = 'COMPLETED' THEN NOW() ELSE completed_at END
        WHERE id = $1`,
      [opts.tokenId, opts.status, opts.assignedStaffId ?? null, opts.assignedResourceId ?? null],
    );

    // Recalculate ETAs for everyone still waiting.
    const waiting = await client.query<{ id: string; total_duration_mins: number }>(
      `SELECT id, total_duration_mins FROM walkin_queue_tokens
        WHERE salon_id = $1 AND queue_date = $2 AND status = 'WAITING'
        ORDER BY token_number`,
      [opts.salonId, token.queue_date],
    );
    let eta = 0;
    for (const row of waiting.rows) {
      eta += row.total_duration_mins;
      await client.query(`UPDATE walkin_queue_tokens SET estimated_wait_mins = $2 WHERE id = $1`, [row.id, eta]);
    }

    return client.query(`SELECT * FROM walkin_queue_tokens WHERE id = $1`, [opts.tokenId]).then((r) => r.rows[0]);
  });

  if (['COMPLETED', 'SKIPPED', 'LEFT_QUEUE'].includes(opts.status)) {
    await redis.zrem(`queue:active:${opts.salonId}`, opts.tokenId).catch(() => {});
  } else if (updated) {
    await redis.zadd(`queue:active:${opts.salonId}`, updated.token_number, opts.tokenId).catch(() => {});
  }

  // Broadcast live queue snapshot over Redis Pub/Sub
  void liveQueue(opts.salonId).then((snapshot) => {
    return redis.publish(`pubsub:queue:${opts.salonId}`, JSON.stringify(snapshot));
  }).catch(() => {});

  if (opts.status === 'CALLED' && updated?.customer_id) {
    const salon = await one<{ name: string }>(`SELECT name FROM salons WHERE id = $1`, [opts.salonId]);
    queueTransactional({
      template: 'QUEUE_CALLED',
      userId: updated.customer_id,
      salonId: opts.salonId,
      context: {
        customerName: updated.walkin_customer_name ?? 'there',
        salonName: salon?.name ?? 'the salon',
        tokenNumber: updated.token_number,
      },
      data: { queue_token_id: updated.id },
    });
  }
  return updated;
}

export async function getTokenStatus(salonId: string, tokenId: string) {
  const token = await one<any>(
    `SELECT * FROM walkin_queue_tokens WHERE id = $1 AND salon_id = $2`,
    [tokenId, salonId],
  );
  if (!token) throw notFound('Queue token not found');

  let peopleAhead = 0;
  if (token.status === 'WAITING') {
    const aheadResult = await one<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM walkin_queue_tokens
        WHERE salon_id = $1 AND queue_date = $2 AND status = 'WAITING' AND token_number < $3`,
      [salonId, token.queue_date, token.token_number],
    );
    peopleAhead = Number(aheadResult?.count ?? 0);
  }

  return {
    token_id: token.id,
    token_number: token.token_number,
    status: token.status,
    customer_name: token.walkin_customer_name,
    queue_date: token.queue_date,
    people_ahead: peopleAhead,
    estimated_wait_mins: token.status === 'IN_SERVICE' ? 0 : token.estimated_wait_mins,
    assigned_staff_id: token.assigned_staff_id,
    assigned_resource_id: token.assigned_resource_id,
    total_duration_mins: token.total_duration_mins,
    joined_at: token.joined_at,
    called_at: token.called_at,
    service_started_at: token.service_started_at,
    completed_at: token.completed_at,
  };
}
