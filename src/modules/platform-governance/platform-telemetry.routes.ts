import { Router } from "express";
import fs from "fs";
import path from "path";
import { asyncHandler } from "../../middleware/async-handler";
import {
  requirePlatformAuth,
  requirePlatformRole,
  logPlatformAudit,
  PlatformAuthedRequest,
} from "../../middleware/platform-auth";
import {
  getSystemHealthTelemetry,
  getSystemTelemetryErrors,
} from "./platform-telemetry.service";
import { memoryLogs, memoryErrors, logger } from "../../utils/logger";

export const platformTelemetryRouter = Router();

platformTelemetryRouter.use(requirePlatformAuth);

/**
 * GET /api/platform/telemetry/health
 * Live infrastructure health dashboard (Devs, Super Admin, Support)
 */
platformTelemetryRouter.get(
  "/health",
  asyncHandler(async (_req: PlatformAuthedRequest, res) => {
    const telemetry = await getSystemHealthTelemetry();
    res.json(telemetry);
  })
);

/**
 * GET /api/platform/telemetry/errors
 * Platform error aggregations and webhook health (Devs, Super Admin)
 */
platformTelemetryRouter.get(
  "/errors",
  requirePlatformRole("super_admin", "platform_dev"),
  asyncHandler(async (_req: PlatformAuthedRequest, res) => {
    const errorStats = await getSystemTelemetryErrors();
    res.json(errorStats);
  })
);

/**
 * GET /api/platform/telemetry/logs
 * Query recent in-memory logs with multi-tenant filtering, log level, module, and keyword search.
 * Accessible to: super_admin, platform_dev, support_agent
 */
platformTelemetryRouter.get(
  "/logs",
  requirePlatformRole("super_admin", "platform_dev", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const level = (req.query.level as string)?.toLowerCase()?.trim();
    const search = (req.query.search as string)?.toLowerCase()?.trim();
    const moduleName = (req.query.module as string)?.toLowerCase()?.trim();
    const tenantId = (req.query.tenantId as string)?.trim();
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    let logs = memoryLogs.getAll().reverse(); // Newest first

    if (tenantId && tenantId !== "all" && tenantId !== "undefined" && tenantId !== "null") {
      logs = logs.filter((l) => l.tenantId === tenantId);
    }

    if (level && level !== "all" && level !== "undefined" && level !== "null") {
      logs = logs.filter((l) => l.level === level);
    }

    if (moduleName && moduleName !== "all" && moduleName !== "undefined" && moduleName !== "null") {
      logs = logs.filter((l) => l.module?.toLowerCase().includes(moduleName));
    }

    if (search && search !== "undefined" && search !== "null") {
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
 * GET /api/platform/telemetry/system-errors
 * Query detailed error stack traces with tenant filtering.
 * Accessible to: super_admin, platform_dev, support_agent
 */
platformTelemetryRouter.get(
  "/system-errors",
  requirePlatformRole("super_admin", "platform_dev", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const search = (req.query.search as string)?.toLowerCase()?.trim();
    const tenantId = (req.query.tenantId as string)?.trim();
    const limit = Math.min(Number(req.query.limit) || 100, 250);

    let errors = memoryErrors.getAll().reverse(); // Newest first

    if (tenantId && tenantId !== "all" && tenantId !== "undefined" && tenantId !== "null") {
      errors = errors.filter((e) => e.tenantId === tenantId);
    }

    if (search && search !== "undefined" && search !== "null") {
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
 * POST /api/platform/telemetry/logs/clear
 * Clears circular in-memory log and error ring buffers.
 * Accessible to: super_admin, platform_dev
 */
platformTelemetryRouter.post(
  "/logs/clear",
  requirePlatformRole("super_admin", "platform_dev"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    memoryLogs.clear();
    memoryErrors.clear();
    logger.info("Platform staff cleared in-memory logs ring buffer", {
      platformUserId: req.platformUser!.id,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "telemetry.logs_cleared",
      targetType: "system_logs",
      targetId: null,
      details: { clearedAt: new Date().toISOString() },
      req,
    });

    res.json({ success: true, message: "In-memory logs and error traces cleared successfully" });
  })
);

/**
 * GET /api/platform/telemetry/logs/download
 * Download raw server disk log file (app.log or error.log)
 * Accessible to: super_admin, platform_dev
 */
platformTelemetryRouter.get(
  "/logs/download",
  requirePlatformRole("super_admin", "platform_dev"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const type = req.query.type === "error" ? "error.log" : "app.log";
    const filePath = path.resolve(process.cwd(), "logs", type);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Log file ${type} not found on host` });
    }

    res.download(filePath, type);
  })
);
