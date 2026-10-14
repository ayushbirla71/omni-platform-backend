import { getElasticsearchClient, MESSAGES_INDEX, CONTACTS_INDEX } from "../../db/elasticsearch";
import { query } from "../../db/pool";
import { Message } from "../messages/messages.service";

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
export const SEARCH_MAX_QUERY_LENGTH = 200;

/** Fewest digits worth running a phone-number substring search for. */
const MIN_PHONE_DIGITS = 3;

export type SearchType = "all" | "messages" | "contacts";

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

export interface ContactIndexDocument {
  tenantId: string;
  name: string | null;
  externalId: string;
}

/** Contacts are indexed even without a name so phone-only contacts stay searchable by number. */
export function buildContactDocument(params: {
  tenantId: string;
  name: string | null;
  externalId: string;
}): ContactIndexDocument {
  return { tenantId: params.tenantId, name: params.name, externalId: params.externalId };
}

export async function indexContact(params: {
  tenantId: string;
  contactId: string;
  name: string | null;
  externalId: string;
}): Promise<void> {
  const es = getElasticsearchClient();
  await es.index({
    index: CONTACTS_INDEX,
    id: params.contactId,
    document: buildContactDocument(params),
  });
}

/** Removes deleted contacts from the index; a missing document is not an error. */
export async function removeContactsFromIndex(contactIds: string[]): Promise<void> {
  if (contactIds.length === 0) return;
  const es = getElasticsearchClient();
  await es.deleteByQuery({
    index: CONTACTS_INDEX,
    query: { ids: { values: contactIds } },
    refresh: true,
    ignore_unavailable: true,
  });
}

export interface MessageSearchHit {
  id: string;
  conversationId: string;
  text: string;
  direction: "inbound" | "outbound";
  createdAt: string | null;
}

export interface ContactSearchHit {
  id: string;
  name: string | null;
  externalId: string;
  channelType: string;
  channelName: string | null;
}

export interface SearchResponse {
  messages: MessageSearchHit[];
  contacts: ContactSearchHit[];
}

interface MessageSource {
  conversationId: string;
  text: string;
  direction: "inbound" | "outbound";
  sentAt?: string;
}

interface ContactRow {
  id: string;
  name: string | null;
  external_id: string;
  channel_type: string;
  channel_display_name: string | null;
}

/** Escapes the wildcard metacharacters so user input is matched literally. */
function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, "\\$&");
}

async function searchMessages(
  tenantId: string,
  queryText: string,
  limit: number
): Promise<MessageSearchHit[]> {
  const es = getElasticsearchClient();
  const result = await es.search<MessageSource>({
    index: MESSAGES_INDEX,
    query: { bool: { must: [{ match: { text: queryText } }], filter: [{ term: { tenantId } }] } },
    sort: [{ _score: { order: "desc" } },{ sentAt: { order: "desc", unmapped_type: "date" } }],
    size: limit,
  });

  return result.hits.hits.flatMap((hit) => {
    const source = hit._source;
    if (!source) return [];
    return [
      {
        id: hit._id as string,
        conversationId: source.conversationId,
        text: source.text,
        direction: source.direction,
        createdAt: source.sentAt ?? null,
      },
    ];
  });
}

async function searchContacts(
  tenantId: string,
  queryText: string,
  limit: number
): Promise<ContactSearchHit[]> {
  const es = getElasticsearchClient();
  const digits = queryText.replace(/\D/g, "");

  const should: Array<Record<string, unknown>> = [
    { match: { name: queryText } },
    { term: { externalId: queryText } },
  ];
  if (digits.length >= MIN_PHONE_DIGITS) {
    should.push({
      wildcard: { externalId: { value: `*${escapeWildcard(digits)}*`, case_insensitive: true } },
    });
  }

  const result = await es.search({
    index: CONTACTS_INDEX,
    query: { bool: { should, minimum_should_match: 1, filter: [{ term: { tenantId } }] } },
    size: limit,
  });

  const orderedIds = result.hits.hits.map((hit) => hit._id as string);
  if (orderedIds.length === 0) return [];

  // Hydrate from Postgres: it is the source of truth, adds the channel, and drops
  // index entries for contacts that were deleted or moved to another tenant.
  const rows = await query<ContactRow>(
    `SELECT ct.id, ct.name, ct.external_id, ch.type AS channel_type,
            ch.display_name AS channel_display_name
       FROM contacts ct
       JOIN channels ch ON ch.id = ct.channel_id
      WHERE ct.id = ANY($1::uuid[]) AND ct.tenant_id = $2`,
    [orderedIds, tenantId]
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));

  return orderedIds.flatMap((id) => {
    const row = rowById.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        name: row.name,
        externalId: row.external_id,
        channelType: row.channel_type,
        channelName: row.channel_display_name,
      },
    ];
  });
}

/**
 * Tenant-scoped full-text search across both messages and contacts. This is
 * the feature Elasticsearch exists for in this stack — Postgres LIKE
 * queries don't scale for chat-log search at volume (architecture doc §3).
 */
export async function search(
  tenantId: string,
  queryText: string,
  options: { type?: SearchType; limit?: number } = {}
): Promise<SearchResponse> {
  const type = options.type ?? "all";
  const limit = options.limit ?? SEARCH_DEFAULT_LIMIT;

  const [messages, contacts] = await Promise.all([
    type === "contacts" ? Promise.resolve([]) : searchMessages(tenantId, queryText, limit),
    type === "messages" ? Promise.resolve([]) : searchContacts(tenantId, queryText, limit),
  ]);

  return { messages, contacts };
}
