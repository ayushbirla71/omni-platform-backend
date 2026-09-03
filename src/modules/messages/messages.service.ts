import { v4 as uuidv4 } from "uuid";
import { getMongoDb } from "../../db/mongo";
import { queryOne } from "../../db/pool";
import { touchLastMessageAt } from "../conversations/conversations.service";
import { getChannelWithCredentials } from "../channels/channels.service";
import { getAdapter } from "../channels/channel-registry";
import { indexMessage } from "../search/search.service";

/**
 * Messages live in MongoDB, not Postgres — per architecture doc §3, chat
 * logs are high write volume with semi-structured payloads that vary per
 * channel, which is exactly the shape Mongo is suited for. Everything else
 * (tenants, contacts, conversations) stays relational in Postgres;
 * conversationId/tenantId here are just plain string fields, not enforced
 * foreign keys — Mongo doesn't have those, so referential integrity for
 * messages is the app's responsibility, not the database's.
 */
export interface Message {
  id: string;
  tenant_id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  type: string;
  content: Record<string, any>;
  sender_user_id: string | null;
  sent_at: string;
  provider_message_id?: string;
}

interface MessageDoc {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  type: string;
  content: Record<string, any>;
  senderUserId: string | null;
  sentAt: Date;
  providerMessageId?: string;
  latestStatus?: "sent" | "delivered" | "read" | "failed";
  latestStatusAt?: Date;
}

interface MessageStatusEventDoc {
  id: string;
  tenantId: string;
  messageId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode?: string;
  errorMessage?: string;
  timestamp: Date;
}

function toMessage(doc: MessageDoc): Message {
  return {
    id: doc.id,
    tenant_id: doc.tenantId,
    conversation_id: doc.conversationId,
    direction: doc.direction,
    type: doc.type,
    content: doc.content,
    sender_user_id: doc.senderUserId,
    sent_at: doc.sentAt.toISOString(),
    provider_message_id: doc.providerMessageId,
  };
}

async function getMessagesCollection() {
  const db = await getMongoDb();
  const collection = db.collection<MessageDoc>("messages");
  // Cheap to call repeatedly — MongoDB no-ops if the index already exists.
  await collection.createIndex({ conversationId: 1, sentAt: 1 });
  await collection.createIndex({ tenantId: 1 });
  await collection.createIndex({ providerMessageId: 1 });
  return collection;
}

async function getMessageStatusEventsCollection() {
  const db = await getMongoDb();
  const collection = db.collection<MessageStatusEventDoc>("message_status_events");
  await collection.createIndex({ providerMessageId: 1 });
  await collection.createIndex({ messageId: 1 });
  await collection.createIndex({ tenantId: 1, timestamp: -1 });
  return collection;
}

export async function recordInboundMessage(params: {
  tenantId: string;
  conversationId: string;
  type: string;
  content: Record<string, any>;
  sentAt: Date;
}): Promise<Message> {
  const { tenantId, conversationId, type, content, sentAt } = params;
  const doc: MessageDoc = {
    id: uuidv4(),
    tenantId,
    conversationId,
    direction: "inbound",
    type,
    content,
    senderUserId: null,
    sentAt,
  };
  const collection = await getMessagesCollection();
  await collection.insertOne(doc);
  await touchLastMessageAt(conversationId);
  const message = toMessage(doc);
  await indexMessage(message).catch((err) => {
    // Search indexing is best-effort — a search-index outage should never
    // block message delivery. See src/modules/search/search.service.ts.
    console.error("[messages] Elasticsearch indexing failed (non-fatal):", err);
  });
  return message;
}

/**
 * Sends a message from an agent (or, later, the flow engine) out through
 * whichever channel the conversation belongs to, then records it.
 */
export async function sendOutboundMessage(params: {
  tenantId: string;
  conversationId: string;
  senderUserId?: string;
  text?: string;
  type?: "text" | "template";
  templateName?: string;
  templateLanguage?: string;
  templateParams?: Record<string, string>;
}): Promise<Message> {
  const { tenantId, conversationId, senderUserId, text, type = "text", templateName, templateLanguage, templateParams } = params;

  const conversation = await queryOne<{ channel_id: string; contact_external_id: string }>(
    `SELECT c.channel_id, ct.external_id AS contact_external_id
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [conversationId, tenantId]
  );
  if (!conversation) throw new Error("Conversation not found");

  const channel = await getChannelWithCredentials(tenantId, conversation.channel_id);
  if (!channel) throw new Error("Channel not found");

  const adapter = getAdapter(channel.type);

  let providerMessageId: string | undefined;

  if (type === "template") {
    // Send WhatsApp template message
    if (!templateName) throw new Error("templateName is required for template messages");
    const result = await adapter.send(
      {
        toExternalContactId: conversation.contact_external_id,
        type: "template",
        templateName,
        templateLanguage,
        templateParams,
      },
      channel.credentials
    );
    providerMessageId = result.providerMessageId;
  } else {
    // Send plain text message
    if (!text) throw new Error("text is required for text messages");
    const result = await adapter.send(
      { toExternalContactId: conversation.contact_external_id, type: "text", text },
      channel.credentials
    );
    providerMessageId = result.providerMessageId;
  }

  const doc: MessageDoc = {
    id: uuidv4(),
    tenantId,
    conversationId,
    direction: "outbound",
    type: type === "template" ? "template" : "text",
    content: type === "template"
      ? { templateName, templateLanguage, templateParams }
      : { text },
    senderUserId: senderUserId || null,
    sentAt: new Date(),
    providerMessageId,
    latestStatus: "sent",
    latestStatusAt: new Date(),
  };
  const collection = await getMessagesCollection();
  await collection.insertOne(doc);
  await touchLastMessageAt(conversationId);
  const message = toMessage(doc);
  await indexMessage(message).catch((err) => {
    console.error("[messages] Elasticsearch indexing failed (non-fatal):", err);
  });
  return message;
}

export async function listMessages(tenantId: string, conversationId: string): Promise<Message[]> {
  const collection = await getMessagesCollection();
  const docs = await collection
    .find({ tenantId, conversationId })
    .sort({ sentAt: 1 })
    .toArray();
  return docs.map(toMessage);
}

export async function findMessageByProviderId(
  providerMessageId: string
): Promise<{ message: Message; tenantId: string; conversationId: string } | null> {
  const collection = await getMessagesCollection();
  const doc = await collection.findOne({ providerMessageId });
  if (!doc) return null;
  return {
    message: toMessage(doc),
    tenantId: doc.tenantId,
    conversationId: doc.conversationId,
  };
}

export async function recordMessageStatusEvent(params: {
  tenantId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode?: string;
  errorMessage?: string;
  timestamp: Date;
}): Promise<{ conversationId?: string }> {
  const { tenantId, providerMessageId, status, errorCode, errorMessage, timestamp } = params;

  const messagesCol = await getMessagesCollection();
  const messageDoc = await messagesCol.findOne({ providerMessageId });

  // Record status event in audit collection
  const statusEventsCol = await getMessageStatusEventsCollection();
  await statusEventsCol.insertOne({
    id: uuidv4(),
    tenantId,
    messageId: messageDoc?.id || "unknown",
    providerMessageId,
    status,
    errorCode,
    errorMessage,
    timestamp,
  });

  // Update latest status on the message doc
  if (messageDoc) {
    await messagesCol.updateOne(
      { id: messageDoc.id },
      { $set: { latestStatus: status, latestStatusAt: timestamp } }
    );
    return { conversationId: messageDoc.conversationId };
  }

  return {};
}
