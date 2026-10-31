import { withTenant } from '../db.js';

export type AnalyticsPeriod = 'TODAY' | 'WEEK' | 'MONTH';

function periodStart(period: AnalyticsPeriod): string {
  switch (period) {
    case 'TODAY':
      return "date_trunc('day', NOW())";
    case 'WEEK':
      return "NOW() - interval '7 days'";
    default:
      return "NOW() - interval '30 days'";
  }
}

/**
 * Owner dashboard. Runs under the tenant GUC so RLS-protected CRM and reminder
 * tables are readable only for this salon.
 */
export async function dashboard(salonId: string, period: AnalyticsPeriod) {
  const start = periodStart(period);

  return withTenant(salonId, async (client) => {
    const revenue = await client.query<{ revenue: string; visits: string }>(
      `SELECT COALESCE(SUM(net_collected_paise), 0)::bigint AS revenue, COUNT(*)::int AS visits
         FROM invoices_and_payments
        WHERE salon_id = $1 AND created_at >= ${start}`,
      [salonId],
    );

    const services = await client.query<{ completed_services: string }>(
      `SELECT COUNT(*)::int AS completed_services
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
        WHERE b.salon_id = $1
          AND b.status = 'COMPLETED'
          AND b.scheduled_start_at >= ${start}`,
      [salonId],
    );

    const crm = await client.query<{ returning: string; new_customers: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE total_visits > 1)::int AS returning,
         COUNT(*) FILTER (WHERE total_visits = 1)::int AS new_customers
       FROM salon_customer_crm
       WHERE salon_id = $1`,
      [salonId],
    );

    const reminders = await client.query<{ sent: string; converted: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','OPENED','CLICKED','CONVERTED_TO_BOOKING'))::int AS sent,
         COUNT(*) FILTER (WHERE status = 'CONVERTED_TO_BOOKING')::int AS converted
       FROM retention_reminders
       WHERE salon_id = $1`,
      [salonId],
    );

    const byStaff = await client.query<{ staff_name: string; revenue_paise: string }>(
      `SELECT sm.display_name AS staff_name,
              COALESCE(SUM(bi.unit_price_paise), 0)::bigint AS revenue_paise
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
         JOIN staff_members sm ON sm.id = bi.staff_id
        WHERE b.salon_id = $1
          AND b.status = 'COMPLETED'
          AND b.scheduled_start_at >= ${start}
        GROUP BY sm.display_name
        ORDER BY revenue_paise DESC`,
      [salonId],
    );

    const revenuePaise = Number(revenue.rows[0]?.revenue ?? 0);
    const visits = Number(revenue.rows[0]?.visits ?? 0);
    const returning = Number(crm.rows[0]?.returning ?? 0);
    const newCustomers = Number(crm.rows[0]?.new_customers ?? 0);
    const sent = Number(reminders.rows[0]?.sent ?? 0);
    const converted = Number(reminders.rows[0]?.converted ?? 0);

    return {
      period,
      revenue_paise: revenuePaise,
      completed_visits: visits,
      completed_services: Number(services.rows[0]?.completed_services ?? 0),
      avg_bill_paise: visits ? Math.round(revenuePaise / visits) : 0,
      returning_customers: returning,
      new_customers: newCustomers,
      retention_rate_pct:
        returning + newCustomers ? Number(((returning / (returning + newCustomers)) * 100).toFixed(1)) : 0,
      reminder_conversion_rate_pct: sent ? Number(((converted / sent) * 100).toFixed(1)) : 0,
      revenue_by_staff: byStaff.rows.map((r) => ({
        staff_name: r.staff_name,
        revenue_paise: Number(r.revenue_paise),
      })),
    };
  });
}
