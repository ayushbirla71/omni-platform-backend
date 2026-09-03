import { Client } from "@elastic/elasticsearch";

let client: Client | null = null;

export function getElasticsearchClient(): Client {
  if (!client) {
    client = new Client({ node: process.env.ELASTICSEARCH_URL || "http://localhost:9200" });
  }
  return client;
}

export const MESSAGES_INDEX = "messages";
export const CONTACTS_INDEX = "contacts";

/** Creates the indices if they don't exist yet. Safe to call repeatedly. */
export async function ensureSearchIndices(): Promise<void> {
  const es = getElasticsearchClient();

  const messagesExist = await es.indices.exists({ index: MESSAGES_INDEX });
  if (!messagesExist) {
    await es.indices.create({
      index: MESSAGES_INDEX,
      mappings: {
        properties: {
          tenantId: { type: "keyword" },
          conversationId: { type: "keyword" },
          direction: { type: "keyword" },
          text: { type: "text" },
          sentAt: { type: "date" },
        },
      },
    });
  }

  const contactsExist = await es.indices.exists({ index: CONTACTS_INDEX });
  if (!contactsExist) {
    await es.indices.create({
      index: CONTACTS_INDEX,
      mappings: {
        properties: {
          tenantId: { type: "keyword" },
          name: { type: "text" },
          externalId: { type: "keyword" },
        },
      },
    });
  }
}
