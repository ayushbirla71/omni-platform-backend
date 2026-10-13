import { Request, Response, NextFunction } from "express";
import { redis, ensureRedisConnected } from "../db/redis";
import { logger } from "../utils/logger";

/**
 * Fixed-window counter (INCR + EXPIRE) on the shared Redis client.
 * Returns true when the caller is still within the limit.
 *
 * Fails open: if Redis is unreachable the request is allowed, so a Redis
 * outage degrades to "no rate limit" instead of locking users out.
 */
export async function hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  try {
    await ensureRedisConnected();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    return count <= limit;
  } catch (err) {
    logger.warn(`[rate-limit] Redis unavailable, allowing request for ${key}`, err);
    return true;
  }
}

/** Per-IP limit for a route, e.g. rateLimitByIp("forgot-password", 5, 15 * 60). */
export function rateLimitByIp(name: string, limit: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const allowed = await hitRateLimit(`ratelimit:${name}:ip:${ip}`, limit, windowSeconds);
    if (!allowed) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }
    next();
  };
}
