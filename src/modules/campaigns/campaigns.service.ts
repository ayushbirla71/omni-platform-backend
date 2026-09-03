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
  failed_count?: number;
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
  const campaign = await queryOne<Campaign>(
    `SELECT c.*,
       COUNT(cr.id)::int as total_recipients,
       COUNT(CASE WHEN cr.status = 'sent' OR cr.status = 'completed' THEN 1 END)::int as sent_count,
       COUNT(CASE WHEN cr.status = 'failed' THEN 1 END)::int as failed_count
     FROM campaigns c
     LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
     WHERE c.id = $1 AND c.tenant_id = $2
     GROUP BY c.id`,
    [campaignId, tenantId]
  );
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
       COUNT(cr.id)::int as total_recipients,
       COUNT(CASE WHEN cr.status = 'sent' OR cr.status = 'completed' THEN 1 END)::int as sent_count,
       COUNT(CASE WHEN cr.status = 'failed' THEN 1 END)::int as failed_count
     FROM campaigns c
     LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
     WHERE c.tenant_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [tenantId]
  );
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
