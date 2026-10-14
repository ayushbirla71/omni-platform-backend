// pool is imported first on purpose: it loads .env before the Mongo/Elasticsearch modules read it.
import { pool, query } from "../db/pool";
import { getMongoDb, closeMongo } from "../db/mongo";
import {
  getElasticsearchClient,
  ensureSearchIndices,
  MESSAGES_INDEX,
  CONTACTS_INDEX,
} from "../db/elasticsearch";
import { buildContactDocument } from "../modules/search/search.service";

/**
 * Rebuilds the Elasticsearch indices behind Global Search from Postgres (contacts) and
 * MongoDB (text messages). Needed once for data created before search indexing existed, and
 * safe to re-run: documents are keyed by row id, so they are overwritten, never duplicated.
 *
 *   npm run reindex:search                       # dry run, only counts what it would index
 *   npm run reindex:search -- --apply            # write to Elasticsearch
 *   npm run reindex:search -- --apply --tenant <tenantId>
 *
 * In production use the compiled script: node dist/scripts/reindex-search.js --apply
 */
const BATCH_SIZE = 500;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface ContactRow {
  id: string;
  tenant_id: string;
  name: string | null;
  external_id: string;
}

interface MessageDoc {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  content?: { text?: string };
  sentAt?: Date;
}

type BulkOperation = object;

async function bulkIndex(operations: BulkOperation[]): Promise<number> {
  if (operations.length === 0) return 0;
  const es = getElasticsearchClient();
  const response = await es.bulk({ operations, refresh: false });
  if (!response.errors) return operations.length / 2;

  const failed = response.items.filter((item) => item.index?.error).length;
  console.error(`  ${failed} document(s) in this batch were rejected by Elasticsearch`);
  return operations.length / 2 - failed;
}

async function reindexContacts(apply: boolean, tenantId?: string): Promise<number> {
  let total = 0;
  let lastId = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    const rows = await query<ContactRow>(
      `SELECT id, tenant_id, name, external_id FROM contacts
        WHERE id > $1 AND ($2::uuid IS NULL OR tenant_id = $2)
        ORDER BY id LIMIT $3`,
      [lastId, tenantId ?? null, BATCH_SIZE]
    );
    if (rows.length === 0) return total;
    lastId = rows[rows.length - 1].id;

    if (apply) {
      const operations = rows.flatMap((row) => [
        { index: { _index: CONTACTS_INDEX, _id: row.id } },
        buildContactDocument({
          tenantId: row.tenant_id,
          name: row.name,
          externalId: row.external_id,
        }),
      ]);
      total += await bulkIndex(operations);
    } else {
      total += rows.length;
    }
  }
}

async function reindexMessages(apply: boolean, tenantId?: string): Promise<number> {
  const mongo = await getMongoDb();
  const cursor = mongo
    .collection<MessageDoc>("messages")
    .find({
      "content.text": { $type: "string", $ne: "" },
      ...(tenantId ? { tenantId } : {}),
    })
    .batchSize(BATCH_SIZE);

  let total = 0;
  let operations: BulkOperation[] = [];

  for await (const doc of cursor) {
    if (!apply) {
      total++;
      continue;
    }
    operations.push(
      { index: { _index: MESSAGES_INDEX, _id: doc.id } },
      {
        tenantId: doc.tenantId,
        conversationId: doc.conversationId,
        direction: doc.direction,
        text: doc.content?.text,
        sentAt: doc.sentAt ? new Date(doc.sentAt).toISOString() : undefined,
      }
    );
    if (operations.length >= BATCH_SIZE * 2) {
      total += await bulkIndex(operations);
      operations = [];
    }
  }
  total += await bulkIndex(operations);
  return total;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = argValue("--tenant");

  if (apply) await ensureSearchIndices();

  const contacts = await reindexContacts(apply, tenantId);
  const messages = await reindexMessages(apply, tenantId);

  if (apply) await getElasticsearchClient().indices.refresh({ index: [CONTACTS_INDEX, MESSAGES_INDEX] });

  console.log(apply ? "Reindex applied:" : "Dry run (nothing written, pass --apply to write):");
  console.log(`  contacts ${apply ? "indexed" : "to index"}: ${contacts}`);
  console.log(`  text messages ${apply ? "indexed" : "to index"}: ${messages}`);
}

main()
  .catch((err) => {
    console.error("Reindex failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo();
    await pool.end();
    process.exit(process.exitCode ?? 0);
  });
