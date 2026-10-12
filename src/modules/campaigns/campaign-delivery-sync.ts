import { query } from "../../db/pool";
import { getMongoDb } from "../../db/mongo";
import { applyDeliveryReceipt } from "./campaigns.service";

/**
 * Keeps campaign_recipients in step with what the provider actually reported for the message
 * (stored on the Mongo message document by the webhook handler).
 *
 *  - syncRecipientWithMessageStatus: closes the race where a delivery receipt arrives before the
 *    sender has saved the provider message id on the recipient row.
 *  - backfillCampaignDelivery: repairs campaigns sent before delivery tracking existed (their
 *    recipients are stuck at "sent" with no provider message id) by matching each recipient to the
 *    outbound message that was sent to that contact when the campaign ran.
 */

interface MessageStatusDoc {
  providerMessageId?: string;
  latestStatus?: "sent" | "delivered" | "read" | "failed";
  latestStatusAt?: Date;
  sentAt?: Date;
  errorCode?: string;
  errorMessage?: string;
}

async function getMessagesCollection() {
  const db = await getMongoDb();
  return db.collection("messages");
}

/** Applies the message's current delivery status to the recipient that owns its provider message id. */
export async function syncRecipientWithMessageStatus(tenantId: string, providerMessageId: string): Promise<boolean> {
  const col = await getMessagesCollection();
  const doc = await col.findOne<MessageStatusDoc>({ tenantId, providerMessageId });
  if (!doc || !doc.latestStatus || doc.latestStatus === "sent") return false;

  return applyDeliveryReceipt({
    tenantId,
    providerMessageId,
    status: doc.latestStatus,
    errorCode: doc.errorCode,
    errorMessage: doc.errorMessage,
    timestamp: doc.latestStatusAt || doc.sentAt || new Date(),
  });
}

export interface BackfillSummary {
  candidates: number;
  matched: number;
  unmatched: number;
  /** Recipient status each matched message resolves to */
  resolved: Record<"sent" | "delivered" | "read" | "failed", number>;
  applied: boolean;
}

// The flow/broadcast message goes out just before the recipient row is marked "sent".
const MATCH_WINDOW_BEFORE_MS = 120_000;
const MATCH_WINDOW_AFTER_MS = 5_000;

export async function backfillCampaignDelivery(options: {
  apply: boolean;
  tenantId?: string;
  campaignId?: string;
}): Promise<BackfillSummary> {
  const { apply, tenantId, campaignId } = options;
  const summary: BackfillSummary = {
    candidates: 0,
    matched: 0,
    unmatched: 0,
    resolved: { sent: 0, delivered: 0, read: 0, failed: 0 },
    applied: apply,
  };

  const params: any[] = [];
  const filters: string[] = [];
  if (tenantId) {
    params.push(tenantId);
    filters.push(`c.tenant_id = $${params.length}`);
  }
  if (campaignId) {
    params.push(campaignId);
    filters.push(`c.id = $${params.length}`);
  }

  const candidates = await query<{
    id: string;
    contact_id: string;
    updated_at: Date;
    tenant_id: string;
    channel_id: string;
  }>(
    `SELECT cr.id, cr.contact_id, cr.updated_at, c.tenant_id, c.channel_id
     FROM campaign_recipients cr
     JOIN campaigns c ON c.id = cr.campaign_id
     WHERE cr.status = 'sent' AND cr.provider_message_id IS NULL AND c.type IN ('broadcast', 'flow')
     ${filters.length ? "AND " + filters.join(" AND ") : ""}
     ORDER BY cr.updated_at`,
    params
  );
  summary.candidates = candidates.length;

  const col = await getMessagesCollection();

  for (const rec of candidates) {
    const conversations = await query<{ id: string }>(
      "SELECT id FROM conversations WHERE tenant_id = $1 AND contact_id = $2 AND channel_id = $3",
      [rec.tenant_id, rec.contact_id, rec.channel_id]
    );
    if (conversations.length === 0) {
      summary.unmatched++;
      continue;
    }

    const sentAt = new Date(rec.updated_at).getTime();
    const doc = await col.findOne<MessageStatusDoc>(
      {
        tenantId: rec.tenant_id,
        conversationId: { $in: conversations.map((c) => c.id) },
        direction: "outbound",
        senderUserId: null, // automation/campaign sends, not a human agent
        providerMessageId: { $type: "string" },
        sentAt: { $gte: new Date(sentAt - MATCH_WINDOW_BEFORE_MS), $lte: new Date(sentAt + MATCH_WINDOW_AFTER_MS) },
      },
      { sort: { sentAt: 1 } }
    );
    if (!doc?.providerMessageId) {
      summary.unmatched++;
      continue;
    }

    summary.matched++;
    const status = doc.latestStatus || "sent";
    summary.resolved[status]++;

    if (!apply) continue;

    await query(
      "UPDATE campaign_recipients SET provider_message_id = $2 WHERE id = $1 AND provider_message_id IS NULL AND status = 'sent'",
      [rec.id, doc.providerMessageId]
    );
    if (status !== "sent") {
      await applyDeliveryReceipt({
        tenantId: rec.tenant_id,
        providerMessageId: doc.providerMessageId,
        status,
        errorCode: doc.errorCode,
        errorMessage: doc.errorMessage,
        timestamp: doc.latestStatusAt || doc.sentAt || new Date(),
      });
    }
  }

  return summary;
}
