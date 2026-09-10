import { Router } from "express";
import fs from "fs";
import path from "path";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { memoryLogs, memoryErrors, logger, LogLevel } from "../../utils/logger";
import { pool } from "../../db/pool";

export const systemRouter = Router();

// Require authentication and owner or admin role for all system log endpoints
systemRouter.use(requireAuth);
systemRouter.use(requireRole("owner", "admin"));

/**
 * GET /api/system/status
 * Returns system health, uptime, memory usage, and runtime info.
 */
systemRouter.get(
  "/status",
  asyncHandler(async (_req: AuthedRequest, res) => {
    let dbStatus = "unknown";
    try {
      const dbRes = await pool.query("SELECT 1 as connected");
      dbStatus = dbRes.rows[0]?.connected === 1 ? "connected" : "error";
    } catch (err: any) {
      dbStatus = `disconnected: ${err?.message || err}`;
    }

    const memoryUsage = process.memoryUsage();
    const systemInfo = {
      status: "healthy",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.floor(process.uptime()),
      database: dbStatus,
      memory: {
        rssMb: Math.round((memoryUsage.rss / 1024 / 1024) * 100) / 100,
        heapTotalMb: Math.round((memoryUsage.heapTotal / 1024 / 1024) * 100) / 100,
        heapUsedMb: Math.round((memoryUsage.heapUsed / 1024 / 1024) * 100) / 100,
        externalMb: Math.round((memoryUsage.external / 1024 / 1024) * 100) / 100,
      },
      logStats: {
        inMemoryLogsCount: memoryLogs.size(),
        inMemoryErrorsCount: memoryErrors.size(),
      },
      environment: process.env.NODE_ENV || "development",
      timestamp: new Date().toISOString(),
    };

    res.json(systemInfo);
  })
);

/**
 * GET /api/system/logs
 * Query recent in-memory logs with filtering.
 * Query params: level, search, module, limit
 */
systemRouter.get(
  "/logs",
  asyncHandler(async (req: AuthedRequest, res) => {
    const level = (req.query.level as string)?.toLowerCase();
    const search = (req.query.search as string)?.toLowerCase();
    const moduleName = (req.query.module as string)?.toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    let logs = memoryLogs.getAll().reverse(); // Newest first

    if (level && level !== "all") {
      logs = logs.filter((l) => l.level === level);
    }

    if (moduleName) {
      logs = logs.filter((l) => l.module?.toLowerCase().includes(moduleName));
    }

    if (search) {
      logs = logs.filter(
        (l) =>
          l.message.toLowerCase().includes(search) ||
          l.reqId?.toLowerCase().includes(search) ||
          l.tenantId?.toLowerCase().includes(search) ||
          (l.error?.message && l.error.message.toLowerCase().includes(search)) ||
          (l.error?.stack && l.error.stack.toLowerCase().includes(search))
      );
    }

    res.json({
      total: logs.length,
      limit,
      logs: logs.slice(0, limit),
    });
  })
);

/**
 * GET /api/system/errors
 * Returns recent errors with full stack traces.
 */
systemRouter.get(
  "/errors",
  asyncHandler(async (req: AuthedRequest, res) => {
    const search = (req.query.search as string)?.toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 100, 250);

    let errors = memoryErrors.getAll().reverse(); // Newest first

    if (search) {
      errors = errors.filter(
        (e) =>
          e.message.toLowerCase().includes(search) ||
          e.reqId?.toLowerCase().includes(search) ||
          e.tenantId?.toLowerCase().includes(search) ||
          (e.error?.message && e.error.message.toLowerCase().includes(search)) ||
          (e.error?.stack && e.error.stack.toLowerCase().includes(search))
      );
    }

    res.json({
      total: errors.length,
      limit,
      errors: errors.slice(0, limit),
    });
  })
);

/**
 * POST /api/system/logs/clear
 * Clears in-memory log and error buffers.
 */
systemRouter.post(
  "/logs/clear",
  asyncHandler(async (_req: AuthedRequest, res) => {
    memoryLogs.clear();
    memoryErrors.clear();
    logger.info("In-memory logs cleared by admin");
    res.json({ success: true, message: "Logs cleared" });
  })
);

/**
 * GET /api/system/logs/download
 * Download raw log file (app.log or error.log)
 */
systemRouter.get(
  "/logs/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const type = req.query.type === "error" ? "error.log" : "app.log";
    const filePath = path.resolve(process.cwd(), "logs", type);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Log file ${type} not found` });
    }

    res.download(filePath, type);
  })
);
