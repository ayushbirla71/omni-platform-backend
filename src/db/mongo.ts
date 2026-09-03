import { MongoClient, Db } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "omni_platform";

let client: MongoClient | null = null;
let db: Db | null = null;

/**
 * Lazily connects on first use rather than at import time — mirrors the
 * Postgres pool's pattern of not failing at module load if the DB isn't
 * reachable yet (useful during startup ordering, and in tests).
 */
export async function getMongoDb(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(MONGODB_URI, {
    // Defaults are 30s, which would otherwise leave a request hanging for a
    // long time if Mongo is unreachable — fail fast instead, consistent
    // with how the rest of this app treats unreachable dependencies as
    // recoverable/non-fatal where possible (see messages.service.ts's
    // best-effort search indexing for the same philosophy). Both timeouts
    // are set — serverSelectionTimeoutMS alone still left a refused
    // connection taking ~12s in testing, not the intended ~5s.
    serverSelectionTimeoutMS: Number(process.env.MONGODB_TIMEOUT_MS) || 5000,
    connectTimeoutMS: Number(process.env.MONGODB_TIMEOUT_MS) || 5000,
  });
  await client.connect();
  db = client.db(MONGODB_DB_NAME);
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
