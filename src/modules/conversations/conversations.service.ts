import { query, queryOne } from "../../db/pool";
import { emitRealtimeEvent } from "../realtime/websocket.service";
import { AuditService } from "../audit/audit.service";
import { ASSIGNABLE_ROLES } from "../teams/teams.service";
import { httpError } from "../../utils/http-error";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "conversations-service" });

export const CONVERSATION_STATUSES = ["open", "pending", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface Conversation {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  assigned_agent_id: string | null;
  assigned_team_id?: string | null;
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

/** Who performed a change; recorded in the audit log. */
export interface ConversationActor {
  userId: string;
  email?: string;
  ipAddress?: string;
}

export interface ConversationFilters {
  status?: ConversationStatus;
  /** A user id, or "unassigned". */
  assignedTo?: string;
  teamId?: string;
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

  const inboundDate = new Date(lastInboundAt);
  const inboundTime = inboundDate.getTime();
  if (isNaN(inboundTime)) {
    return {
      isOpen: false,
      expiresAt: null,
      secondsRemaining: 0,
      isExpired: true,
      lastInboundAt: null,
    };
  }

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

/**
 * One non-closed conversation per contact. A closed conversation is never reopened by a new
 * customer message: it stays a finished record and the message starts a new one.
 */
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

interface ConversationRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  assigned_agent_id: string | null;
  assigned_team_id: string | null;
  last_message_at: Date | string | null;
  last_inbound_at: Date | string | null;
  created_at: Date | string | null;
  contact_name: string | null;
  contact_external_id: string | null;
  channel_type: string | null;
  channel_display_name: string | null;
  assigned_agent_name: string | null;
  assigned_team_name: string | null;
}

/** Columns + joins shared by the conversation list and detail queries. */
const CONVERSATION_SELECT_SQL = `
  SELECT
    c.id,
    c.tenant_id,
    c.contact_id,
    c.channel_id,
    c.status,
    c.assigned_agent_id,
    c.assigned_team_id,
    c.last_message_at,
    c.last_inbound_at,
    c.created_at,
    ct.name AS contact_name,
    ct.external_id AS contact_external_id,
    ch.type AS channel_type,
    ch.display_name AS channel_display_name,
    COALESCE(u.name, u.email) AS assigned_agent_name,
    tm.name AS assigned_team_name
  FROM conversations c
  LEFT JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN channels ch ON ch.id = c.channel_id
  LEFT JOIN users u ON u.id = c.assigned_agent_id AND u.tenant_id = c.tenant_id
  LEFT JOIN teams tm ON tm.id = c.assigned_team_id AND tm.tenant_id = c.tenant_id`;

const toIso = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

function mapConversationRow(r: ConversationRow) {
  const sessionWindow = computeSessionWindow(r.last_inbound_at, r.channel_type ?? undefined);
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
    assignedAgentName: r.assigned_agent_name,
    assignedTeamId: r.assigned_team_id,
    assignedTeamName: r.assigned_team_name,
    lastMessageAt: toIso(r.last_message_at),
    last_message_at: toIso(r.last_message_at),
    lastInboundAt: toIso(r.last_inbound_at),
    last_inbound_at: toIso(r.last_inbound_at),
    sessionWindow,
    session_window: sessionWindow,
    createdAt: toIso(r.created_at),
    created_at: toIso(r.created_at),
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

export type ConversationView = ReturnType<typeof mapConversationRow>;

export async function listConversations(
  tenantId: string,
  filters: ConversationFilters = {}
): Promise<Array<ConversationView & { lastMessageText: string; last_message_text: string }>> {
  const conditions = ["c.tenant_id = $1"];
  const params: unknown[] = [tenantId];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (filters.assignedTo === "unassigned") {
    conditions.push("c.assigned_agent_id IS NULL");
  } else if (filters.assignedTo) {
    params.push(filters.assignedTo);
    conditions.push(`c.assigned_agent_id = $${params.length}`);
  }
  if (filters.teamId) {
    params.push(filters.teamId);
    conditions.push(`c.assigned_team_id = $${params.length}`);
  }

  const sql = `
    ${CONVERSATION_SELECT_SQL}
    WHERE ${conditions.join(" AND ")}
    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
  `;

  const rows = await query<ConversationRow>(sql, params);
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
    log.warn("Could not load latest message previews", { error: (err as Error).message });
  }

  return rows.map((r) => ({
    ...mapConversationRow(r),
    lastMessageText: latestMessageMap[r.id] || "",
    last_message_text: latestMessageMap[r.id] || "",
  }));
}

export async function getConversation(
  tenantId: string,
  conversationId: string
): Promise<ConversationView | null> {
  const r = await queryOne<ConversationRow>(
    `${CONVERSATION_SELECT_SQL} WHERE c.id = $1 AND c.tenant_id = $2`,
    [conversationId, tenantId]
  );
  return r ? mapConversationRow(r) : null;
}

/** Tells every open inbox the conversation changed; they merge the payload into their list. */
async function emitConversationUpdate(tenantId: string, conversationId: string): Promise<void> {
  try {
    const view = await getConversation(tenantId, conversationId);
    if (!view) return;
    await emitRealtimeEvent(tenantId, "conversation:update", view, { conversationId });
  } catch (err) {
    log.warn("Realtime conversation update failed", { error: (err as Error).message });
  }
}

function recordConversationAudit(
  tenantId: string,
  actor: ConversationActor,
  action: string,
  conversationId: string,
  details: Record<string, unknown>
): Promise<void> {
  return AuditService.record({
    tenantId,
    userId: actor.userId,
    userEmail: actor.email,
    action,
    resourceType: "conversation",
    resourceId: conversationId,
    details,
    ipAddress: actor.ipAddress,
  });
}

/** An assignee must be an active owner/admin/agent of *this* workspace (never a viewer). */
async function assertAssignableAgent(tenantId: string, userId: string): Promise<void> {
  const user = await queryOne<{ id: string }>(
    `SELECT id FROM users
     WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND role = ANY($3::text[])`,
    [userId, tenantId, [...ASSIGNABLE_ROLES]]
  );
  if (!user) {
    throw httpError(400, "Assignee must be an active owner, admin or agent of this workspace");
  }
}

/** Assigns the conversation to an agent, or unassigns it when `agentUserId` is null. */
export async function assignAgent(
  tenantId: string,
  conversationId: string,
  agentUserId: string | null,
  actor: ConversationActor
): Promise<void> {
  if (agentUserId) await assertAssignableAgent(tenantId, agentUserId);

  const updated = await queryOne<{ previous_agent_id: string | null }>(
    `UPDATE conversations c SET assigned_agent_id = $1
     FROM (SELECT id, assigned_agent_id FROM conversations WHERE id = $2 AND tenant_id = $3) prev
     WHERE c.id = prev.id
     RETURNING prev.assigned_agent_id AS previous_agent_id`,
    [agentUserId, conversationId, tenantId]
  );
  if (!updated) throw httpError(404, "Conversation not found");

  await recordConversationAudit(
    tenantId,
    actor,
    agentUserId ? "conversation.assigned" : "conversation.unassigned",
    conversationId,
    { from: updated.previous_agent_id, to: agentUserId }
  );
  emitRealtimeEvent(
    tenantId,
    "conversation:assigned",
    { conversationId, assignedAgentUserId: agentUserId },
    { conversationId }
  ).catch((err) => log.warn("Realtime assign event failed", { error: err.message }));
  await emitConversationUpdate(tenantId, conversationId);
}

/** Routes the conversation to a support team, or clears the team when `teamId` is null. */
export async function assignTeam(
  tenantId: string,
  conversationId: string,
  teamId: string | null,
  actor: ConversationActor
): Promise<void> {
  if (teamId) {
    const team = await queryOne<{ id: string }>(
      "SELECT id FROM teams WHERE id = $1 AND tenant_id = $2",
      [teamId, tenantId]
    );
    if (!team) throw httpError(404, "Team not found");
  }

  const updated = await queryOne<{ previous_team_id: string | null }>(
    `UPDATE conversations c SET assigned_team_id = $1
     FROM (SELECT id, assigned_team_id FROM conversations WHERE id = $2 AND tenant_id = $3) prev
     WHERE c.id = prev.id
     RETURNING prev.assigned_team_id AS previous_team_id`,
    [teamId, conversationId, tenantId]
  );
  if (!updated) throw httpError(404, "Conversation not found");

  await recordConversationAudit(tenantId, actor, "conversation.team_assigned", conversationId, {
    from: updated.previous_team_id,
    to: teamId,
  });
  await emitConversationUpdate(tenantId, conversationId);
}

/**
 * Takes an unassigned case for yourself (or confirms one you already hold). A single atomic
 * UPDATE decides the winner when two agents claim at once; the loser gets a 409.
 */
export async function claimConversation(
  tenantId: string,
  conversationId: string,
  actor: ConversationActor
): Promise<void> {
  await assertAssignableAgent(tenantId, actor.userId);

  const claimed = await queryOne<{ id: string }>(
    `UPDATE conversations
     SET assigned_agent_id = $1,
         status = CASE WHEN status = 'pending' THEN 'open' ELSE status END
     WHERE id = $2 AND tenant_id = $3 AND status <> 'closed'
       AND (assigned_agent_id IS NULL OR assigned_agent_id = $1)
     RETURNING id`,
    [actor.userId, conversationId, tenantId]
  );

  if (!claimed) {
    const current = await queryOne<{ status: string }>(
      "SELECT status FROM conversations WHERE id = $1 AND tenant_id = $2",
      [conversationId, tenantId]
    );
    if (!current) throw httpError(404, "Conversation not found");
    if (current.status === "closed") throw httpError(409, "This case is closed — reopen it first");
    throw httpError(409, "This case is already assigned to another agent");
  }

  await recordConversationAudit(tenantId, actor, "conversation.claimed", conversationId, {});
  await emitConversationUpdate(tenantId, conversationId);
}

export async function updateConversationStatus(
  tenantId: string,
  conversationId: string,
  status: ConversationStatus,
  actor: ConversationActor
): Promise<void> {
  // Closing stamps the resolution time; reopening / pending clears it so SLA numbers stay true.
  const updated = await queryOne<{ previous_status: string }>(
    `UPDATE conversations c
     SET status = $1::text,
         resolved_at = CASE WHEN $1::text = 'closed' THEN COALESCE(c.resolved_at, now()) ELSE NULL END,
         resolution_duration_seconds = CASE
           WHEN $1::text = 'closed'
           THEN COALESCE(c.resolution_duration_seconds, EXTRACT(EPOCH FROM (now() - c.created_at))::INTEGER)
           ELSE NULL END
     FROM (SELECT id, status FROM conversations WHERE id = $2 AND tenant_id = $3) prev
     WHERE c.id = prev.id
     RETURNING prev.status AS previous_status`,
    [status, conversationId, tenantId]
  );
  if (!updated) throw httpError(404, "Conversation not found");

  if (status === "closed") {
    // Release handed_off / active flow runs so the next inbound message starts fresh.
    // Safe to key on conversation_id: the tenant-scoped UPDATE above already matched.
    await query(
      `UPDATE flow_runs SET status = 'completed', updated_at = now()
       WHERE conversation_id = $1 AND (status = 'handed_off' OR status = 'running')`,
      [conversationId]
    );
  }

  await recordConversationAudit(tenantId, actor, "conversation.status_changed", conversationId, {
    from: updated.previous_status,
    to: status,
  });
  emitRealtimeEvent(tenantId, "conversation:status", { conversationId, status }, { conversationId }).catch(
    (err) => log.warn("Realtime status event failed", { error: err.message })
  );
  await emitConversationUpdate(tenantId, conversationId);
}

export async function resumeBotForConversation(
  tenantId: string,
  conversationId: string,
  actor: ConversationActor
): Promise<void> {
  const conversation = await queryOne<{ id: string }>(
    "SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2",
    [conversationId, tenantId]
  );
  if (!conversation) throw httpError(404, "Conversation not found");

  await query(
    `UPDATE flow_runs SET status = 'completed', updated_at = now()
     WHERE conversation_id = $1 AND (status = 'handed_off' OR status = 'running')`,
    [conversationId]
  );

  await recordConversationAudit(tenantId, actor, "conversation.bot_resumed", conversationId, {});
  emitRealtimeEvent(tenantId, "conversation:bot_resumed", { conversationId }, { conversationId }).catch(
    (err) => log.warn("Realtime bot-resumed event failed", { error: err.message })
  );
}

/** A bot flow handed the conversation to a human: surface it as "pending" until someone takes it. */
export async function markConversationNeedsHuman(
  tenantId: string,
  conversationId: string
): Promise<void> {
  const changed = await queryOne<{ id: string }>(
    `UPDATE conversations SET status = 'pending'
     WHERE id = $1 AND tenant_id = $2 AND status = 'open' RETURNING id`,
    [conversationId, tenantId]
  );
  if (changed) await emitConversationUpdate(tenantId, conversationId);
}

/**
 * A human agent replied: take an unassigned case for them and move "pending" to "open".
 * Ignores ids that are not an active agent of the tenant (e.g. API keys) and closed cases.
 */
export async function claimOnHumanReply(
  tenantId: string,
  conversationId: string,
  userId: string
): Promise<void> {
  const changed = await queryOne<{ id: string }>(
    `UPDATE conversations
     SET assigned_agent_id = COALESCE(assigned_agent_id, $1),
         status = CASE WHEN status = 'pending' THEN 'open' ELSE status END
     WHERE id = $2 AND tenant_id = $3 AND status <> 'closed'
       AND (assigned_agent_id IS NULL OR status = 'pending')
       AND EXISTS (
         SELECT 1 FROM users
         WHERE id = $1 AND tenant_id = $3 AND status = 'active' AND role = ANY($4::text[])
       )
     RETURNING id`,
    [userId, conversationId, tenantId, [...ASSIGNABLE_ROLES]]
  );
  if (changed) await emitConversationUpdate(tenantId, conversationId);
}
