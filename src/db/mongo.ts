import { MongoClient, Db } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27018";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "omni_platform";

let client: MongoClient | null = null;
let db: Db | null = null;

/**
 * Lazily connects on first use rather than at import time — mirrors the
 * Postgres pool's pattern of not failing at module load if the DB isn't
 * reachable yet (useful during startup ordering, and in tests).
 */
export async function getMongoDb(): Promise<Db> {
  if (db && client) return db;
  try {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: Number(process.env.MONGODB_TIMEOUT_MS) || 4000,
      connectTimeoutMS: Number(process.env.MONGODB_TIMEOUT_MS) || 4000,
    });
    await client.connect();
    db = client.db(MONGODB_DB_NAME);
    return db;
  } catch (err) {
    if (client) {
      try {
        await client.close();
      } catch (_) {}
    }
    client = null;
    db = null;
    throw err;
  }
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
