import { getElasticsearchClient, MESSAGES_INDEX, CONTACTS_INDEX } from "../../db/elasticsearch";
import { Message } from "../messages/messages.service";

/**
 * Called after every message is persisted (see messages.service.ts).
 * Deliberately fire-and-forget from the caller's perspective — indexing
 * failure should never block message delivery, so callers wrap this in a
 * .catch() rather than awaiting it strictly. Only text-bearing messages are
 * indexed; there's nothing useful to full-text search in a bare image/doc
 * attachment without OCR/transcription, which is out of scope here.
 */
export async function indexMessage(message: Message): Promise<void> {
  const text = message.content?.text;
  if (!text) return;

  const es = getElasticsearchClient();
  await es.index({
    index: MESSAGES_INDEX,
    id: message.id,
    document: {
      tenantId: message.tenant_id,
      conversationId: message.conversation_id,
      direction: message.direction,
      text,
      sentAt: message.sent_at,
    },
  });
}

export async function indexContact(params: {
  tenantId: string;
  contactId: string;
  name: string | null;
  externalId: string;
}): Promise<void> {
  if (!params.name) return; // nothing text-searchable without a name
  const es = getElasticsearchClient();
  await es.index({
    index: CONTACTS_INDEX,
    id: params.contactId,
    document: { tenantId: params.tenantId, name: params.name, externalId: params.externalId },
  });
}

export interface SearchResult {
  type: "message" | "contact";
  id: string;
  snippet: string;
  conversationId?: string;
}

/**
 * Tenant-scoped full-text search across both messages and contacts. This is
 * the feature Elasticsearch exists for in this stack — Postgres LIKE
 * queries don't scale for chat-log search at volume (architecture doc §3).
 */
export async function search(tenantId: string, queryText: string): Promise<SearchResult[]> {
  const es = getElasticsearchClient();

  const [messagesResult, contactsResult] = await Promise.all([
    es.search({
      index: MESSAGES_INDEX,
      query: { bool: { must: [{ match: { text: queryText } }], filter: [{ term: { tenantId } }] } },
      size: 20,
    }),
    es.search({
      index: CONTACTS_INDEX,
      query: { bool: { must: [{ match: { name: queryText } }], filter: [{ term: { tenantId } }] } },
      size: 20,
    }),
  ]);

  const messageHits: SearchResult[] = messagesResult.hits.hits.map((hit: any) => ({
    type: "message" as const,
    id: hit._id,
    snippet: hit._source.text,
    conversationId: hit._source.conversationId,
  }));

  const contactHits: SearchResult[] = contactsResult.hits.hits.map((hit: any) => ({
    type: "contact" as const,
    id: hit._id,
    snippet: hit._source.name,
  }));

  return [...messageHits, ...contactHits];
}
