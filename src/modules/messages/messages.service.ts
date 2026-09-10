import { v4 as uuidv4 } from "uuid";
import { getMongoDb } from "../../db/mongo";
import { query, queryOne } from "../../db/pool";
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
  _id?: string;
  id: string;
  tenant_id: string;
  tenantId?: string;
  conversation_id: string;
  conversationId?: string;
  direction: "inbound" | "outbound";
  type: string;
  text?: string;
  mediaUrl?: string;
  mediaStorageKey?: string;
  content: Record<string, any>;
  sender_user_id: string | null;
  senderUserId?: string | null;
  senderType?: "customer" | "agent" | "bot" | "system";
  sent_at: string;
  sentAt?: string;
  createdAt?: string;
  created_at?: string;
  provider_message_id?: string;
  providerMessageId?: string;
  status?: "received" | "sent" | "delivered" | "read" | "failed";
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
  const rawText = doc.content?.text || (typeof doc.content === "string" ? doc.content : "");
  const text =
    rawText ||
    (doc.type === "template" ? `[Template: ${doc.content?.templateName || ""}]` : "") ||
    (doc.type === "image" ? "[Image]" : "") ||
    (doc.type === "document" ? (doc.content?.filename ? `[Document: ${doc.content.filename}]` : "[Document]") : "") ||
    (doc.type === "audio" ? "[Audio]" : "") ||
    (doc.type === "video" ? "[Video]" : "") ||
    (doc.type === "sticker" ? "[Sticker]" : "") ||
    "";

  const isoDate = doc.sentAt ? new Date(doc.sentAt).toISOString() : new Date().toISOString();
  const mediaStorageKey = doc.content?.mediaStorageKey;
  const mediaUrl = doc.content?.mediaUrl || doc.content?.mediaProviderId;

  return {
    _id: doc.id,
    id: doc.id,
    tenant_id: doc.tenantId,
    tenantId: doc.tenantId,
    conversation_id: doc.conversationId,
    conversationId: doc.conversationId,
    direction: doc.direction,
    type: doc.type,
    text,
    mediaUrl,
    mediaStorageKey,
    content: doc.content,
    sender_user_id: doc.senderUserId,
    senderUserId: doc.senderUserId,
    senderType: doc.direction === "inbound" ? "customer" : (doc.senderUserId ? "agent" : "bot"),
    sent_at: isoDate,
    sentAt: isoDate,
    createdAt: isoDate,
    created_at: isoDate,
    provider_message_id: doc.providerMessageId,
    providerMessageId: doc.providerMessageId,
    status: doc.latestStatus || (doc.direction === "inbound" ? "received" : "sent"),
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
  providerMessageId?: string;
}): Promise<{ message: Message; isDuplicate: boolean }> {
  const { tenantId, conversationId, type, content, sentAt, providerMessageId } = params;
  const collection = await getMessagesCollection();

  // Deduplication check: if this provider message was already stored, return the existing message
  if (providerMessageId) {
    const existing = await collection.findOne({ providerMessageId });
    if (existing) {
      return { message: toMessage(existing), isDuplicate: true };
    }
  }

  const doc: MessageDoc = {
    id: uuidv4(),
    tenantId,
    conversationId,
    direction: "inbound",
    type,
    content,
    senderUserId: null,
    sentAt,
    providerMessageId,
  };
  await collection.insertOne(doc);
  await touchLastMessageAt(conversationId);
  const message = toMessage(doc);
  indexMessage(message).catch((err) => {
    // Search indexing is best-effort — a search-index outage should never
    // block message delivery. See src/modules/search/search.service.ts.
    console.error("[messages] Elasticsearch indexing failed (non-fatal):", err);
  });
  return { message, isDuplicate: false };
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
  headerType?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";
  headerValue?: string;
}): Promise<Message> {
  const { tenantId, conversationId, senderUserId, text, type = "text", templateName, templateLanguage, templateParams, headerType, headerValue } = params;

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
        headerType,
        headerValue,
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
      ? { templateName, templateLanguage, templateParams, headerType, headerValue }
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

  if (senderUserId) {
    // When a human agent sends a message from the inbox, pause/hand off any active flow run
    // so automated bot flows don't collide with the human agent.
    try {
      await query(
        "UPDATE flow_runs SET status = 'handed_off', updated_at = now() WHERE conversation_id = $1 AND status = 'running'",
        [conversationId]
      );
    } catch {}
  }

  const message = toMessage(doc);
  indexMessage(message).catch((err) => {
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
