import { createClient } from "redis";
import { randomUUID } from "crypto";

export const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });

redis.on("error", (err) => console.error("Redis client error", err));

let connected = false;
export async function ensureRedisConnected() {
  if (!connected) {
    await redis.connect();
    connected = true;
  }
}

/**
 * Simple distributed lock (SET NX PX). Used so two near-simultaneous
 * webhook deliveries for the same conversation (Meta retries, or two
 * messages arriving a few ms apart) can't both advance the same flow_run
 * at once and corrupt its state. Not a full Redlock — fine for a single
 * Redis instance, revisit if Redis is ever sharded/clustered.
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T | "locked"> {
  await ensureRedisConnected();
  const token = randomUUID();
  const acquired = await redis.set(key, token, { NX: true, PX: ttlMs });
  if (!acquired) return "locked";

  try {
    return await fn();
  } finally {
    // Only release if we still hold it (avoid deleting someone else's lock
    // if this one expired and was re-acquired mid-execution).
    const current = await redis.get(key);
    if (current === token) await redis.del(key);
  }
}
