import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  // A background/idle client error should never crash the whole process silently.
  console.error("Unexpected error on idle Postgres client", err);
});

/**
 * Thin query helper. Deliberately NOT an ORM — callers write real SQL.
 * Every query that touches tenant-scoped tables must include a tenant_id
 * predicate; there is no automatic row-level filtering here.
 */
export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows;
}

export async function queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run a set of queries inside a transaction. Pass a callback that receives
 * a client and does its own pool.query-style calls against it.
 */
export async function withTransaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
