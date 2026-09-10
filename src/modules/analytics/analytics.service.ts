import { query, queryOne } from "../../db/pool";
import { getMongoDb } from "../../db/mongo";

export interface AnalyticsOverview {
  totalMessages: number;
  inboundMessages: number;
  outboundMessages: number;
  totalConversations: number;
  openConversations: number;
  closedConversations: number;
  totalContacts: number;
  totalRevenue: number;
  totalOrders: number;
  paidOrders: number;
  channelDistribution: { channelType: string; count: number }[];
}

export interface SlaPerformanceMetrics {
  avgFirstResponseSeconds: number;
  avgResolutionSeconds: number;
  slaBreachCount: number;
  slaComplianceRate: number; // percentage, e.g. 94.5
  totalResolvedCount: number;
  agentScorecard: {
    userId: string;
    name: string;
    email: string;
    role: string;
    assignedConversations: number;
    resolvedConversations: number;
    avgFirstResponseSeconds: number;
    avgResolutionSeconds: number;
  }[];
}

export interface TrafficHeatmapCell {
  dayOfWeek: number; // 0 (Sun) to 6 (Sat)
  hourOfDay: number; // 0 to 23
  count: number;
}

export interface FunnelStage {
  stage: string;
  count: number;
  conversionRate: number; // % relative to previous stage
  dropoffRate: number;
}

export interface AnalyticsDateRange {
  startDate?: Date;
  endDate?: Date;
}

/**
 * Calculates high-level executive KPIs across messaging, CRM, commerce, and channels
 */
export async function getAnalyticsOverview(
  tenantId: string,
  _range?: AnalyticsDateRange
): Promise<AnalyticsOverview> {
  // Aggregate Postgres counts
  const convStats = await queryOne<{ total: string; open: string; closed: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'open')::text AS open,
       COUNT(*) FILTER (WHERE status = 'closed')::text AS closed
     FROM conversations
     WHERE tenant_id = $1`,
    [tenantId]
  );

  const contactStats = await queryOne<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM contacts WHERE tenant_id = $1`,
    [tenantId]
  );

  const orderStats = await queryOne<{ total_revenue: string; total_orders: string; paid_orders: string }>(
    `SELECT
       COALESCE(SUM(total_amount) FILTER (WHERE payment_status = 'paid'), 0)::text AS total_revenue,
       COUNT(*)::text AS total_orders,
       COUNT(*) FILTER (WHERE payment_status = 'paid')::text AS paid_orders
     FROM orders
     WHERE tenant_id = $1`,
    [tenantId]
  );

  // Aggregate Mongo message stats
  let totalMessages = 0;
  let inboundMessages = 0;
  let outboundMessages = 0;
  const channelDistribution: { channelType: string; count: number }[] = [];

  try {
    const db = await getMongoDb();
    const messagesCol = db.collection("messages");

    const [msgCount, inCount, outCount] = await Promise.all([
      messagesCol.countDocuments({ tenantId }),
      messagesCol.countDocuments({ tenantId, direction: "inbound" }),
      messagesCol.countDocuments({ tenantId, direction: "outbound" }),
    ]);

    totalMessages = msgCount;
    inboundMessages = inCount;
    outboundMessages = outCount;
  } catch (err) {
    // Non-fatal fallback
  }

  // Fetch channel breakdown from conversations + channels
  try {
    const channelRows = await query<{ channel_type: string; count: string }>(
      `SELECT ch.type AS channel_type, COUNT(c.id)::text AS count
       FROM conversations c
       JOIN channels ch ON ch.id = c.channel_id
       WHERE c.tenant_id = $1
       GROUP BY ch.type`,
      [tenantId]
    );

    for (const row of channelRows) {
      channelDistribution.push({
        channelType: row.channel_type,
        count: parseInt(row.count, 10) || 0,
      });
    }
  } catch {}

  return {
    totalMessages,
    inboundMessages,
    outboundMessages,
    totalConversations: parseInt(convStats?.total || "0", 10),
    openConversations: parseInt(convStats?.open || "0", 10),
    closedConversations: parseInt(convStats?.closed || "0", 10),
    totalContacts: parseInt(contactStats?.total || "0", 10),
    totalRevenue: parseFloat(orderStats?.total_revenue || "0"),
    totalOrders: parseInt(orderStats?.total_orders || "0", 10),
    paidOrders: parseInt(orderStats?.paid_orders || "0", 10),
    channelDistribution,
  };
}

/**
 * Calculates First Response Time (FRT), Resolution Time (ART), SLA Compliance, and Agent Scorecard
 */
export async function getSlaPerformanceMetrics(
  tenantId: string,
  slaThresholdSeconds: number = 300 // default 5 min SLA
): Promise<SlaPerformanceMetrics> {
  const summary = await queryOne<{
    avg_frt: string | null;
    avg_art: string | null;
    total_responded: string;
    sla_breached_count: string;
    total_resolved: string;
  }>(
    `SELECT
       AVG(first_response_duration_seconds)::text AS avg_frt,
       AVG(resolution_duration_seconds)::text AS avg_art,
       COUNT(*) FILTER (WHERE first_response_duration_seconds IS NOT NULL)::text AS total_responded,
       COUNT(*) FILTER (WHERE first_response_duration_seconds > $2)::text AS sla_breached_count,
       COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::text AS total_resolved
     FROM conversations
     WHERE tenant_id = $1`,
    [tenantId, slaThresholdSeconds]
  );

  const totalResponded = parseInt(summary?.total_responded || "0", 10);
  const slaBreachCount = parseInt(summary?.sla_breached_count || "0", 10);
  const slaComplianceRate = totalResponded > 0
    ? Math.round(((totalResponded - slaBreachCount) / totalResponded) * 1000) / 10
    : 100;

  // Agent scorecard breakdown
  const agentRows = await query<{
    user_id: string;
    name: string;
    email: string;
    role: string;
    assigned_count: string;
    resolved_count: string;
    avg_frt: string | null;
    avg_art: string | null;
  }>(
    `SELECT
       u.id AS user_id,
       u.name,
       u.email,
       u.role,
       COUNT(c.id)::text AS assigned_count,
       COUNT(c.id) FILTER (WHERE c.status = 'closed')::text AS resolved_count,
       AVG(c.first_response_duration_seconds)::text AS avg_frt,
       AVG(c.resolution_duration_seconds)::text AS avg_art
     FROM users u
     LEFT JOIN conversations c ON c.assigned_agent_id = u.id AND c.tenant_id = $1
     WHERE u.tenant_id = $1
     GROUP BY u.id, u.name, u.email, u.role
     ORDER BY COUNT(c.id) DESC`,
    [tenantId]
  );

  const agentScorecard = agentRows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    assignedConversations: parseInt(r.assigned_count, 10) || 0,
    resolvedConversations: parseInt(r.resolved_count, 10) || 0,
    avgFirstResponseSeconds: r.avg_frt ? Math.round(parseFloat(r.avg_frt)) : 0,
    avgResolutionSeconds: r.avg_art ? Math.round(parseFloat(r.avg_art)) : 0,
  }));

  return {
    avgFirstResponseSeconds: summary?.avg_frt ? Math.round(parseFloat(summary.avg_frt)) : 0,
    avgResolutionSeconds: summary?.avg_art ? Math.round(parseFloat(summary.avg_art)) : 0,
    slaBreachCount,
    slaComplianceRate,
    totalResolvedCount: parseInt(summary?.total_resolved || "0", 10),
    agentScorecard,
  };
}

/**
 * Builds 7-day x 24-hour message volume matrix for heatmaps
 */
export async function getTrafficHeatmap(tenantId: string): Promise<TrafficHeatmapCell[]> {
  const matrix: Map<string, number> = new Map();

  // Initialize 7x24 grid with 0s
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      matrix.set(`${day}:${hour}`, 0);
    }
  }

  try {
    const db = await getMongoDb();
    const messagesCol = db.collection("messages");

    const aggregation = await messagesCol
      .aggregate([
        { $match: { tenantId } },
        {
          $project: {
            dayOfWeek: { $dayOfWeek: "$sentAt" }, // Mongo 1 (Sun) to 7 (Sat)
            hourOfDay: { $hour: "$sentAt" },       // 0 to 23
          },
        },
        {
          $group: {
            _id: { day: "$dayOfWeek", hour: "$hourOfDay" },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    for (const item of aggregation) {
      if (item._id?.day !== undefined && item._id?.hour !== undefined) {
        // Convert Mongo 1-7 to 0-6 (0=Sun, 6=Sat)
        const day = (item._id.day - 1) % 7;
        const hour = item._id.hour;
        matrix.set(`${day}:${hour}`, item.count);
      }
    }
  } catch (err) {
    // Non-fatal
  }

  const result: TrafficHeatmapCell[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      result.push({
        dayOfWeek: day,
        hourOfDay: hour,
        count: matrix.get(`${day}:${hour}`) || 0,
      });
    }
  }

  return result;
}

/**
 * Calculates multi-stage conversion funnel from Lead acquisition to Paid Orders
 */
export async function getConversionFunnel(tenantId: string): Promise<FunnelStage[]> {
  const counts = await queryOne<{
    total_contacts: string;
    conversations_engaged: string;
    deals_created: string;
    deals_won: string;
    orders_paid: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM contacts WHERE tenant_id = $1) AS total_contacts,
       (SELECT COUNT(*)::text FROM conversations WHERE tenant_id = $1) AS conversations_engaged,
       (SELECT COUNT(*)::text FROM deals WHERE tenant_id = $1) AS deals_created,
       (SELECT COUNT(*)::text FROM deals WHERE tenant_id = $1 AND stage = 'closed_won') AS deals_won,
       (SELECT COUNT(*)::text FROM orders WHERE tenant_id = $1 AND payment_status = 'paid') AS orders_paid`,
    [tenantId]
  );

  const c1 = parseInt(counts?.total_contacts || "0", 10);
  const c2 = parseInt(counts?.conversations_engaged || "0", 10);
  const c3 = parseInt(counts?.deals_created || "0", 10);
  const c4 = parseInt(counts?.deals_won || "0", 10);
  const c5 = parseInt(counts?.orders_paid || "0", 10);

  const rawStages = [
    { name: "Inbound Contacts", count: Math.max(c1, c2) },
    { name: "Conversations Started", count: c2 },
    { name: "Deals Created", count: c3 },
    { name: "Deals Won", count: c4 },
    { name: "Paid Orders", count: c5 },
  ];

  const funnel: FunnelStage[] = [];
  for (let i = 0; i < rawStages.length; i++) {
    const current = rawStages[i];
    const prev = i === 0 ? current.count : rawStages[i - 1].count;
    const rate = prev > 0 ? Math.min(100, Math.round((current.count / prev) * 1000) / 10) : 100;
    const dropoff = Math.max(0, Math.round((100 - rate) * 10) / 10);

    funnel.push({
      stage: current.name,
      count: current.count,
      conversionRate: rate,
      dropoffRate: dropoff,
    });
  }

  return funnel;
}
