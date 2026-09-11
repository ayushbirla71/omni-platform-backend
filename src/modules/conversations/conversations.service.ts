import { query, queryOne } from "../../db/pool";
import { emitRealtimeEvent } from "../realtime/websocket.service";

export interface Conversation {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_at: string | null;
  last_inbound_at?: string | null;
  created_at: string;
}

export interface SessionWindow {
  isOpen: boolean;
  expiresAt: string | null;
  secondsRemaining: number;
  isExpired: boolean;
  lastInboundAt: string | null;
}

export function computeSessionWindow(
  lastInboundAt: string | Date | null | undefined,
  channelType: string = "whatsapp"
): SessionWindow {
  if (channelType !== "whatsapp") {
    return {
      isOpen: true,
      expiresAt: null,
      secondsRemaining: 86400,
      isExpired: false,
      lastInboundAt: lastInboundAt ? new Date(lastInboundAt).toISOString() : null,
    };
  }

  if (!lastInboundAt) {
    return {
      isOpen: false,
      expiresAt: null,
      secondsRemaining: 0,
      isExpired: true,
      lastInboundAt: null,
    };
  }

  const inboundTime = new Date(lastInboundAt).getTime();
  const now = Date.now();
  const windowDurationMs = 24 * 60 * 60 * 1000;
  const expiresTime = inboundTime + windowDurationMs;
  const secondsRemaining = Math.max(0, Math.floor((expiresTime - now) / 1000));
  const isExpired = now > expiresTime;

  return {
    isOpen: !isExpired,
    expiresAt: new Date(expiresTime).toISOString(),
    secondsRemaining,
    isExpired,
    lastInboundAt: new Date(inboundTime).toISOString(),
  };
}

/** One open conversation per contact — reopen it if it exists, otherwise start one. */
export async function findOrCreateOpenConversation(params: {
  tenantId: string;
  contactId: string;
  channelId: string;
}): Promise<Conversation> {
  const { tenantId, contactId, channelId } = params;

  const existing = await queryOne<Conversation>(
    `SELECT * FROM conversations
     WHERE contact_id = $1 AND status != 'closed'
     ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  );
  if (existing) return existing;

  const created = await queryOne<Conversation>(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, status)
     VALUES ($1, $2, $3, 'open') RETURNING *`,
    [tenantId, contactId, channelId]
  );
  return created!;
}

export async function touchLastMessageAt(conversationId: string) {
  await query("UPDATE conversations SET last_message_at = now() WHERE id = $1", [conversationId]);
}

export async function touchLastInboundAt(conversationId: string, timestamp: Date = new Date()) {
  await query(
    "UPDATE conversations SET last_message_at = $1, last_inbound_at = $1 WHERE id = $2",
    [timestamp, conversationId]
  );
}

export async function listConversations(
  tenantId: string,
  status?: string
): Promise<any[]> {
  const conditions = ["c.tenant_id = $1"];
  const params: any[] = [tenantId];

  if (status) {
    params.push(status);
    conditions.push(`c.status = $${params.length}`);
  }

  const sql = `
    SELECT
      c.id,
      c.tenant_id,
      c.contact_id,
      c.channel_id,
      c.status,
      c.assigned_agent_id,
      c.last_message_at,
      c.last_inbound_at,
      c.created_at,
      ct.name AS contact_name,
      ct.external_id AS contact_external_id,
      ch.type AS channel_type,
      ch.display_name AS channel_display_name
    FROM conversations c
    LEFT JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN channels ch ON ch.id = c.channel_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
  `;

  const rows = await query<any>(sql, params);
  if (rows.length === 0) return [];

  // Fetch latest message text from MongoDB for each conversation
  const convIds = rows.map((r) => r.id);
  const latestMessageMap: Record<string, string> = {};

  try {
    const { getMongoDb } = await import("../../db/mongo");
    const db = await getMongoDb();
    const messagesCol = db.collection("messages");

    const latestDocs = await messagesCol
      .aggregate([
        { $match: { conversationId: { $in: convIds } } },
        { $sort: { sentAt: -1 } },
        {
          $group: {
            _id: "$conversationId",
            content: { $first: "$content" },
            type: { $first: "$type" },
          },
        },
      ])
      .toArray();

    for (const doc of latestDocs) {
      const text =
        doc.content?.text ||
        (typeof doc.content === "string" ? doc.content : "") ||
        (doc.type === "template" ? `[Template: ${doc.content?.templateName || ""}]` : "") ||
        (doc.type ? `[${doc.type}]` : "");
      latestMessageMap[doc._id] = text;
    }
  } catch (err) {
    // Non-fatal MongoDB aggregation fallback
  }

  return rows.map((r) => {
    const sessionWindow = computeSessionWindow(r.last_inbound_at, r.channel_type);
    return {
      id: r.id,
      tenantId: r.tenant_id,
      tenant_id: r.tenant_id,
      contactId: r.contact_id,
      contact_id: r.contact_id,
      channelId: r.channel_id,
      channel_id: r.channel_id,
      status: r.status,
      assignedAgentUserId: r.assigned_agent_id,
      assigned_agent_id: r.assigned_agent_id,
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      last_message_at: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at).toISOString() : null,
      last_inbound_at: r.last_inbound_at ? new Date(r.last_inbound_at).toISOString() : null,
      sessionWindow,
      session_window: sessionWindow,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      contactName: r.contact_name || null,
      contact_name: r.contact_name || null,
      contactExternalId: r.contact_external_id || null,
      contact_external_id: r.contact_external_id || null,
      channelType: r.channel_type || "whatsapp",
      channel_type: r.channel_type || "whatsapp",
      channelDisplayName: r.channel_display_name || null,
      channel_display_name: r.channel_display_name || null,
      lastMessageText: latestMessageMap[r.id] || "",
      last_message_text: latestMessageMap[r.id] || "",
    };
  });
}

export async function getConversation(
  tenantId: string,
  conversationId: string
): Promise<any | null> {
  const sql = `
    SELECT
      c.id,
      c.tenant_id,
      c.contact_id,
      c.channel_id,
      c.status,
      c.assigned_agent_id,
      c.last_message_at,
      c.last_inbound_at,
      c.created_at,
      ct.name AS contact_name,
      ct.external_id AS contact_external_id,
      ch.type AS channel_type,
      ch.display_name AS channel_display_name
    FROM conversations c
    LEFT JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN channels ch ON ch.id = c.channel_id
    WHERE c.id = $1 AND c.tenant_id = $2
  `;

  const r = await queryOne<any>(sql, [conversationId, tenantId]);
  if (!r) return null;

  const sessionWindow = computeSessionWindow(r.last_inbound_at, r.channel_type);

  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenant_id: r.tenant_id,
    contactId: r.contact_id,
    contact_id: r.contact_id,
    channelId: r.channel_id,
    channel_id: r.channel_id,
    status: r.status,
    assignedAgentUserId: r.assigned_agent_id,
    assigned_agent_id: r.assigned_agent_id,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    last_message_at: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at).toISOString() : null,
    last_inbound_at: r.last_inbound_at ? new Date(r.last_inbound_at).toISOString() : null,
    sessionWindow,
    session_window: sessionWindow,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    contactName: r.contact_name || null,
    contact_name: r.contact_name || null,
    contactExternalId: r.contact_external_id || null,
    contact_external_id: r.contact_external_id || null,
    channelType: r.channel_type || "whatsapp",
    channel_type: r.channel_type || "whatsapp",
    channelDisplayName: r.channel_display_name || null,
    channel_display_name: r.channel_display_name || null,
  };
}

export async function assignAgent(
  tenantId: string,
  conversationId: string,
  agentUserId: string
): Promise<void> {
  await query(
    "UPDATE conversations SET assigned_agent_id = $1 WHERE id = $2 AND tenant_id = $3",
    [agentUserId, conversationId, tenantId]
  );
  emitRealtimeEvent(
    tenantId,
    "conversation:assigned",
    { conversationId, assignedAgentUserId: agentUserId },
    { conversationId }
  ).catch(() => {});
}

export async function updateConversationStatus(
  tenantId: string,
  conversationId: string,
  status: "open" | "pending" | "closed"
): Promise<void> {
  if (status === "closed") {
    await query(
      `UPDATE conversations
       SET status = $1,
           resolved_at = now(),
           resolution_duration_seconds = EXTRACT(EPOCH FROM (now() - created_at))::INTEGER
       WHERE id = $2 AND tenant_id = $3`,
      [status, conversationId, tenantId]
    );
  } else {
    await query(
      "UPDATE conversations SET status = $1 WHERE id = $2 AND tenant_id = $3",
      [status, conversationId, tenantId]
    );
  }

  emitRealtimeEvent(
    tenantId,
    "conversation:status",
    { conversationId, status },
    { conversationId }
  ).catch(() => {});
}
