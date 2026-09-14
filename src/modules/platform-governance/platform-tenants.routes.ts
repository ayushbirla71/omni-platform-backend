import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler";
import {
  requirePlatformAuth,
  requirePlatformRole,
  logPlatformAudit,
  PlatformAuthedRequest,
} from "../../middleware/platform-auth";
import {
  listTenantsMetadata,
  getTenantMetadataById,
  updateTenantGovernance,
  getPlatformOverviewAggregations,
} from "./platform-tenants.service";

export const platformTenantsRouter = Router();

/**
 * All routes require platform staff authentication.
 */
platformTenantsRouter.use(requirePlatformAuth);

/**
 * GET /api/platform/tenants/overview
 * Platform-wide aggregation summary stats (Super Admin, Dev, Support)
 */
platformTenantsRouter.get(
  "/overview",
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const stats = await getPlatformOverviewAggregations();
    res.json(stats);
  })
);

/**
 * GET /api/platform/tenants
 * Master Tenant Metadata Catalog with filtering & pagination
 * (Accessible by: super_admin, platform_dev, support_agent, platform_tester)
 * Strict Privacy Shield: Zero customer PII or conversation content returned.
 */
platformTenantsRouter.get(
  "/",
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const { search, plan, planStatus, page, limit } = req.query;

    const results = await listTenantsMetadata({
      search: typeof search === "string" ? search : undefined,
      plan: typeof plan === "string" ? plan : undefined,
      planStatus: typeof planStatus === "string" ? planStatus : undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });

    res.json(results);
  })
);

/**
 * GET /api/platform/tenants/:tenantId
 * Single workspace metadata overview (Metadata only)
 */
platformTenantsRouter.get(
  "/:tenantId",
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const tenant = await getTenantMetadataById(req.params.tenantId);
    if (!tenant) {
      return res.status(404).json({ error: "Tenant workspace not found" });
    }
    res.json(tenant);
  })
);

/**
 * PUT /api/platform/tenants/:tenantId/governance
 * Update plan, subscription status (suspend/activate), and resource quotas.
 * Restricted to Super Admin.
 */
platformTenantsRouter.put(
  "/:tenantId/governance",
  requirePlatformRole("super_admin"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const { tenantId } = req.params;
    const {
      plan,
      planStatus,
      planExpiresAt,
      maxChannels,
      maxContacts,
      maxMonthlyMessages,
      messageQuotaMonthly,
      maxMonthlyAiQueries,
    } = req.body;

    const quota = maxMonthlyMessages !== undefined ? maxMonthlyMessages : messageQuotaMonthly;

    const updated = await updateTenantGovernance({
      tenantId,
      plan,
      planStatus,
      planExpiresAt,
      maxChannels: maxChannels !== undefined ? Number(maxChannels) : undefined,
      maxContacts: maxContacts !== undefined ? Number(maxContacts) : undefined,
      maxMonthlyMessages: quota !== undefined ? Number(quota) : undefined,
      maxMonthlyAiQueries: maxMonthlyAiQueries !== undefined ? Number(maxMonthlyAiQueries) : undefined,
    });

    // Record immutable audit log
    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "tenant.governance_update",
      targetType: "tenant",
      targetId: tenantId,
      details: {
        plan,
        planStatus,
        maxChannels,
        maxContacts,
        maxMonthlyMessages: quota,
      },
      req,
    });

    res.json(updated);
  })
);
