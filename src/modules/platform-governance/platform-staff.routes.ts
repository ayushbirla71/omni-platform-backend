import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler";
import {
  requirePlatformAuth,
  requirePlatformRole,
  logPlatformAudit,
  PlatformAuthedRequest,
} from "../../middleware/platform-auth";
import {
  listPlatformStaff,
  createPlatformStaff,
  updatePlatformStaff,
  listPlatformAuditLogs,
} from "./platform-staff.service";

export const platformStaffRouter = Router();

platformStaffRouter.use(requirePlatformAuth);

/**
 * GET /api/platform/staff
 * List all platform staff members (Super Admin only)
 */
platformStaffRouter.get(
  "/",
  requirePlatformRole("super_admin"),
  asyncHandler(async (_req: PlatformAuthedRequest, res) => {
    const staff = await listPlatformStaff();
    res.json(staff);
  })
);

/**
 * POST /api/platform/staff
 * Create a new internal platform staff member (Super Admin only)
 */
platformStaffRouter.post(
  "/",
  requirePlatformRole("super_admin"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const { email, password, name, role } = req.body;

    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: "email, password, name, and role are required" });
    }

    const newStaff = await createPlatformStaff({
      email,
      password,
      name,
      role,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "staff.create",
      targetType: "platform_user",
      targetId: newStaff.id,
      details: { email: newStaff.email, role: newStaff.role },
      req,
    });

    res.status(201).json(newStaff);
  })
);

/**
 * PUT /api/platform/staff/:staffId
 * Update staff role or status (Super Admin only)
 */
platformStaffRouter.put(
  "/:staffId",
  requirePlatformRole("super_admin"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const { staffId } = req.params;
    const { role, status, name } = req.body;

    const updated = await updatePlatformStaff({
      staffId,
      role,
      status,
      name,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "staff.update",
      targetType: "platform_user",
      targetId: staffId,
      details: { role, status, name },
      req,
    });

    res.json(updated);
  })
);

/**
 * GET /api/platform/staff/audit-logs
 * View platform staff administrative audit trail (Super Admin, Dev, Support)
 */
platformStaffRouter.get(
  "/audit-logs",
  requirePlatformRole("super_admin", "platform_dev", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const { action, targetType, tenantId, limit } = req.query;

    const logs = await listPlatformAuditLogs({
      action: typeof action === "string" ? action : undefined,
      targetType: typeof targetType === "string" ? targetType : undefined,
      tenantId: typeof tenantId === "string" ? tenantId : undefined,
      limit: limit ? Number(limit) : 50,
    });

    res.json(logs);
  })
);
