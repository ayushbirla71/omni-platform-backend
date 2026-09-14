import os from "os";
import { pool, query, queryOne } from "../../db/pool";
import { redis } from "../../db/redis";
import { realtimeGateway } from "../realtime/websocket.service";

export interface SystemHealthTelemetry {
  server: {
    nodeVersion: string;
    platform: string;
    architecture: string;
    uptimeSeconds: number;
    cpuCount: number;
    loadAverage: number[];
    freeMemoryMb: number;
    totalMemoryMb: number;
  };
  process: {
    pid: number;
    uptimeSeconds: number;
    memory: {
      rssMb: number;
      heapTotalMb: number;
      heapUsedMb: number;
      externalMb: number;
    };
    cpuUsagePercent?: number;
  };
  database: {
    status: "healthy" | "degraded" | "unreachable";
    pingLatencyMs: number;
    pool: {
      totalCount: number;
      idleCount: number;
      waitingCount: number;
    };
    version?: string;
  };
  redis: {
    status: "healthy" | "degraded" | "unreachable";
    pingLatencyMs: number;
    connected: boolean;
  };
  realtime: {
    activeConnections: number;
    activeTenants: number;
  };
  telemetryTimestamp: string;
}

export async function getSystemHealthTelemetry(): Promise<SystemHealthTelemetry> {
  const mem = process.memoryUsage();

  // 1. Check PostgreSQL Database Connection Pool
  let dbStatus: "healthy" | "degraded" | "unreachable" = "healthy";
  let dbPingLatencyMs = -1;
  let dbVersion = "PostgreSQL";

  const dbStart = Date.now();
  try {
    const dbRes = await queryOne<{ version: string }>("SELECT version()");
    dbPingLatencyMs = Date.now() - dbStart;
    if (dbRes?.version) {
      dbVersion = dbRes.version.split(" on ")[0];
    }
  } catch (err) {
    dbStatus = "unreachable";
    dbPingLatencyMs = -1;
  }

  // 2. Check Redis Health
  let redisStatus: "healthy" | "degraded" | "unreachable" = "healthy";
  let redisPingLatencyMs = -1;
  let redisConnected = false;

  const redisStart = Date.now();
  try {
    if (redis.isOpen) {
      const pong = await redis.ping();
      redisPingLatencyMs = Date.now() - redisStart;
      redisConnected = pong === "PONG";
      if (!redisConnected) redisStatus = "degraded";
    } else {
      redisStatus = "unreachable";
    }
  } catch (err) {
    redisStatus = "unreachable";
    redisPingLatencyMs = -1;
  }

  // 3. Check WebSocket Realtime Gateway Stats
  const wsStats = realtimeGateway.getStats();

  return {
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      uptimeSeconds: Math.floor(os.uptime()),
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg(),
      freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
      totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    },
    process: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round((mem.rss / (1024 * 1024)) * 100) / 100,
        heapTotalMb: Math.round((mem.heapTotal / (1024 * 1024)) * 100) / 100,
        heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100,
        externalMb: Math.round((mem.external / (1024 * 1024)) * 100) / 100,
      },
    },
    database: {
      status: dbStatus,
      pingLatencyMs: dbPingLatencyMs,
      pool: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
      version: dbVersion,
    },
    redis: {
      status: redisStatus,
      pingLatencyMs: redisPingLatencyMs,
      connected: redisConnected,
    },
    realtime: {
      activeConnections: wsStats.totalConnections || 0,
      activeTenants: wsStats.activeTenants || 0,
    },
    telemetryTimestamp: new Date().toISOString(),
  };
}

export async function getSystemTelemetryErrors(): Promise<{
  webhookFailuresLast24h: number;
  recentAuditActionCounts: Array<{ action: string; count: number }>;
}> {
  const [webhookFailuresRes, auditActionsRes] = await Promise.all([
    queryOne<{ count: string }>(
      "SELECT count(*) FROM webhook_delivery_logs WHERE status = 'failed' AND created_at > now() - interval '24 hours'"
    ).catch(() => ({ count: "0" })),
    query<{ action: string; count: string }>(
      "SELECT action, count(*)::text FROM platform_audit_logs WHERE created_at > now() - interval '24 hours' GROUP BY action ORDER BY count DESC LIMIT 10"
    ).catch(() => []),
  ]);

  return {
    webhookFailuresLast24h: parseInt(webhookFailuresRes?.count || "0", 10),
    recentAuditActionCounts: auditActionsRes.map((r) => ({
      action: r.action,
      count: parseInt(r.count, 10),
    })),
  };
}
