import { query, queryOne, withTransaction } from "../../db/pool";
import { BroadcastDefinition, DripDefinition, FlowCampaignDefinition } from "./campaigns.types";
import { getContactIdsByFilter } from "../contacts/contacts.service";

export interface Campaign {
  id: string;
  tenant_id: string;
  channel_id: string;
  name: string;
  type: "broadcast" | "drip" | "flow";
  definition: BroadcastDefinition | DripDefinition | FlowCampaignDefinition;
  status: "draft" | "sending" | "completed";
  total_recipients?: number;
  sent_count?: number;
  completed_count?: number;
  failed_count?: number;
  pending_count?: number;
  channel_type?: string;
  channel_display_name?: string;
  flow_name?: string;
  flow_status?: string;
  created_at: string;
}

export interface CampaignRecipient {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: "pending" | "sent" | "failed" | "completed";
  current_step: number;
  next_send_at: string;
  last_error: string | null;
  updated_at: string;
  contact_name?: string | null;
  contact_external_id?: string;
  contact_email?: string | null;
  contact_attributes?: Record<string, any>;
  conversation_id?: string | null;
}

/**
 * Creates the campaign plus one campaign_recipients row per targeted contact.
 * Audience can be supplied as an explicit contactIds array OR resolved dynamically
 * via tag / channel filtering.
 */
export async function createCampaign(params: {
  tenantId: string;
  channelId: string;
  name: string;
  type: "broadcast" | "drip" | "flow";
  definition: BroadcastDefinition | DripDefinition | FlowCampaignDefinition;
  contactIds?: string[];
  tags?: string[];
}): Promise<Campaign> {
  const { tenantId, channelId, name, type, definition, tags } = params;
  let contactIds = params.contactIds || [];

  // If no explicit contact IDs are given, resolve from audience tags
  if (contactIds.length === 0) {
    const audienceTags = tags || (definition as any)?.tags;
    contactIds = await getContactIdsByFilter(tenantId, { channelId, tags: audienceTags });
  }

  if (contactIds.length === 0) {
    throw new Error("No contacts match the specified audience criteria or tag filter");
  }

  return withTransaction(async (client) => {
    const campaignResult = await client.query(
      `INSERT INTO campaigns (tenant_id, channel_id, name, type, definition)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tenantId, channelId, name, type, definition]
    );
    const campaign = campaignResult.rows[0] as Campaign;

    for (const contactId of contactIds) {
      await client.query(
        `INSERT INTO campaign_recipients (campaign_id, contact_id, next_send_at)
         VALUES ($1, $2, now())
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [campaign.id, contactId]
      );
    }

    campaign.total_recipients = contactIds.length;
    campaign.sent_count = 0;
    campaign.failed_count = 0;

    return campaign;
  });
}

export async function getCampaign(tenantId: string, campaignId: string): Promise<Campaign | null> {
  const sql = `
    SELECT
      c.*,
      ch.type AS channel_type,
      ch.display_name AS channel_display_name,
      COUNT(cr.id)::int as total_recipients,
      COUNT(CASE WHEN cr.status = 'sent' THEN 1 END)::int as sent_count,
      COUNT(CASE WHEN cr.status = 'completed' THEN 1 END)::int as completed_count,
      COUNT(CASE WHEN cr.status = 'failed' THEN 1 END)::int as failed_count,
      COUNT(CASE WHEN cr.status = 'pending' THEN 1 END)::int as pending_count
    FROM campaigns c
    LEFT JOIN channels ch ON ch.id = c.channel_id
    LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
    WHERE c.id = $1 AND c.tenant_id = $2
    GROUP BY c.id, ch.type, ch.display_name
  `;
  const campaign = await queryOne<Campaign>(sql, [campaignId, tenantId]);
  if (!campaign) return null;

  // If this is a flow campaign or has a flowId, look up the flow name and status
  const flowId = (campaign.definition as any)?.flowId;
  if (flowId && typeof flowId === "string") {
    try {
      const flow = await queryOne<{ name: string; status: string }>(
        "SELECT name, status FROM flows WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL",
        [flowId, tenantId]
      );
      if (flow) {
        campaign.flow_name = flow.name;
        campaign.flow_status = flow.status;
      }
    } catch {}
  }

  return campaign;
}

export async function deleteCampaign(tenantId: string, campaignId: string): Promise<boolean> {
  const res = await query(
    "DELETE FROM campaigns WHERE id = $1 AND tenant_id = $2 RETURNING id",
    [campaignId, tenantId]
  );
  return res.length > 0;
}

/**
 * Used only by the cross-tenant drip poller (processDueDripSteps), which by
 * design has no single tenant context to scope by — it's finding due work
 * across every tenant at once. Every other caller must use getCampaign
 * above and pass a verified tenantId.
 */
export async function getCampaignByIdUnscoped(campaignId: string): Promise<Campaign | null> {
  return queryOne<Campaign>("SELECT * FROM campaigns WHERE id = $1", [campaignId]);
}

export async function listCampaigns(tenantId: string): Promise<Campaign[]> {
  return query<Campaign>(
    `SELECT c.*,
       ch.type AS channel_type,
       ch.display_name AS channel_display_name,
       COUNT(cr.id)::int as total_recipients,
       COUNT(CASE WHEN cr.status = 'sent' THEN 1 END)::int as sent_count,
       COUNT(CASE WHEN cr.status = 'completed' THEN 1 END)::int as completed_count,
       COUNT(CASE WHEN cr.status = 'failed' THEN 1 END)::int as failed_count,
       COUNT(CASE WHEN cr.status = 'pending' THEN 1 END)::int as pending_count
     FROM campaigns c
     LEFT JOIN channels ch ON ch.id = c.channel_id
     LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
     WHERE c.tenant_id = $1
     GROUP BY c.id, ch.type, ch.display_name
     ORDER BY c.created_at DESC`,
    [tenantId]
  );
}

export async function getCampaignRecipients(
  tenantId: string,
  campaignId: string,
  options: { status?: string; search?: string; limit?: number; offset?: number } = {}
): Promise<{ recipients: CampaignRecipient[]; total: number }> {
  // First verify campaign belongs to tenant
  const campaign = await queryOne<{ id: string; channel_id: string }>(
    "SELECT id, channel_id FROM campaigns WHERE id = $1 AND tenant_id = $2",
    [campaignId, tenantId]
  );
  if (!campaign) return { recipients: [], total: 0 };

  const { status, search, limit = 50, offset = 0 } = options;
  const conditions = ["cr.campaign_id = $1"];
  const params: any[] = [campaignId];

  if (status && status !== "all") {
    params.push(status);
    conditions.push(`cr.status = $${params.length}`);
  }

  if (search && search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    conditions.push(`(LOWER(ct.name) LIKE $${params.length} OR LOWER(ct.external_id) LIKE $${params.length})`);
  }

  // Count total matching
  const countSql = `
    SELECT COUNT(cr.id)::int AS count
    FROM campaign_recipients cr
    JOIN contacts ct ON ct.id = cr.contact_id
    WHERE ${conditions.join(" AND ")}
  `;
  const countResult = await queryOne<{ count: number }>(countSql, params);
  const total = countResult?.count || 0;

  // Query paginated rows
  const queryParams = [...params, limit, offset];
  const limitParam = `$${queryParams.length - 1}`;
  const offsetParam = `$${queryParams.length}`;

  const sql = `
    SELECT
      cr.id,
      cr.campaign_id,
      cr.contact_id,
      cr.status,
      cr.current_step,
      cr.next_send_at,
      cr.last_error,
      cr.updated_at,
      ct.name AS contact_name,
      ct.external_id AS contact_external_id,
      (ct.attributes->>'email') AS contact_email,
      ct.attributes AS contact_attributes,
      conv.id AS conversation_id
    FROM campaign_recipients cr
    JOIN contacts ct ON ct.id = cr.contact_id
    LEFT JOIN LATERAL (
      SELECT id FROM conversations
      WHERE contact_id = cr.contact_id AND tenant_id = '${tenantId}'
      ORDER BY created_at DESC LIMIT 1
    ) conv ON true
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE WHEN cr.status = 'failed' THEN 1 WHEN cr.status = 'pending' THEN 2 ELSE 3 END,
      cr.updated_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const recipients = await query<CampaignRecipient>(sql, queryParams);
  return { recipients, total };
}

export async function getCampaignAnalytics(tenantId: string, campaignId: string): Promise<any | null> {
  const campaign = await getCampaign(tenantId, campaignId);
  if (!campaign) return null;

  // Step breakdown for Drip campaigns
  const stepStats = await query<{ step: number; count: number }>(
    `SELECT current_step AS step, COUNT(id)::int AS count
     FROM campaign_recipients
     WHERE campaign_id = $1
     GROUP BY current_step
     ORDER BY current_step ASC`,
    [campaignId]
  );

  // Status breakdown
  const statusStats = await query<{ status: string; count: number }>(
    `SELECT status, COUNT(id)::int AS count
     FROM campaign_recipients
     WHERE campaign_id = $1
     GROUP BY status`,
    [campaignId]
  );

  const total = campaign.total_recipients || 0;
  const sent = campaign.sent_count || 0;
  const completed = campaign.completed_count || 0;
  const failed = campaign.failed_count || 0;
  const pending = campaign.pending_count || 0;
  const deliveredTotal = sent + completed;

  const deliveryRate = total > 0 ? Math.round((deliveredTotal / total) * 100) : 0;
  const failureRate = total > 0 ? Math.round((failed / total) * 100) : 0;
  const pendingRate = total > 0 ? Math.round((pending / total) * 100) : 0;

  return {
    campaign,
    metrics: {
      totalRecipients: total,
      sentCount: sent,
      completedCount: completed,
      deliveredTotal,
      failedCount: failed,
      pendingCount: pending,
      deliveryRate,
      failureRate,
      pendingRate,
    },
    statusBreakdown: statusStats,
    stepBreakdown: stepStats,
  };
}

export async function setCampaignStatus(campaignId: string, status: Campaign["status"]): Promise<void> {
  await query("UPDATE campaigns SET status = $1 WHERE id = $2", [status, campaignId]);
}

export async function getRecipientsByStatus(
  campaignId: string,
  status: CampaignRecipient["status"]
): Promise<(CampaignRecipient & { external_id: string; name: string | null })[]> {
  return query(
    `SELECT cr.*, c.external_id, c.name
     FROM campaign_recipients cr
     JOIN contacts c ON c.id = cr.contact_id
     WHERE cr.campaign_id = $1 AND cr.status = $2`,
    [campaignId, status]
  );
}

/** Every recipient row (across all campaigns) whose next scheduled send is due now. */
export async function getDueDripRecipients(): Promise<
  (CampaignRecipient & { external_id: string; name: string | null; campaign_id: string })[]
> {
  return query(
    `SELECT cr.*, c.external_id, c.name
     FROM campaign_recipients cr
     JOIN contacts c ON c.id = cr.contact_id
     JOIN campaigns camp ON camp.id = cr.campaign_id
     WHERE camp.type = 'drip' AND cr.status = 'pending' AND cr.next_send_at <= now()`
  );
}

/** A broadcast recipient sends exactly once — mark it sent, done. */
export async function markBroadcastSent(recipientId: string): Promise<void> {
  await query(
    "UPDATE campaign_recipients SET status = 'sent', updated_at = now() WHERE id = $1",
    [recipientId]
  );
}

/** A drip recipient just received one step's message; schedule the next one. */
export async function advanceDripRecipient(
  recipientId: string,
  nextStep: number,
  nextSendAt: Date
): Promise<void> {
  await query(
    `UPDATE campaign_recipients
     SET current_step = $1, next_send_at = $2, updated_at = now()
     WHERE id = $3`,
    [nextStep, nextSendAt, recipientId]
  );
}

/** A drip recipient has received its final step. */
export async function completeDripRecipient(recipientId: string): Promise<void> {
  await query(
    "UPDATE campaign_recipients SET status = 'completed', updated_at = now() WHERE id = $1",
    [recipientId]
  );
}

export async function markRecipientFailed(recipientId: string, error: string): Promise<void> {
  await query(
    "UPDATE campaign_recipients SET status = 'failed', last_error = $1, updated_at = now() WHERE id = $2",
    [error, recipientId]
  );
}
