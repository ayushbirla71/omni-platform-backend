import { query, queryOne } from "../../db/pool";

export interface Conversation {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_at: string | null;
  created_at: string;
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

export async function listConversations(
  tenantId: string,
  status?: string
): Promise<Conversation[]> {
  if (status) {
    return query<Conversation>(
      "SELECT * FROM conversations WHERE tenant_id = $1 AND status = $2 ORDER BY last_message_at DESC NULLS LAST",
      [tenantId, status]
    );
  }
  return query<Conversation>(
    "SELECT * FROM conversations WHERE tenant_id = $1 ORDER BY last_message_at DESC NULLS LAST",
    [tenantId]
  );
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
}
