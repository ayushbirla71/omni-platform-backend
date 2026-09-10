import { Router, Response } from "express";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { BillingService } from "./billing.service";
import { asyncHandler } from "../../middleware/async-handler";

export const billingRouter = Router();

billingRouter.use(requireAuth);

/**
 * GET /api/billing/usage
 * Get real-time usage consumption and plan limits
 */
billingRouter.get(
  "/usage",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const summary = await BillingService.getUsageAndQuotas(tenantId);
    res.json(summary);
  })
);

/**
 * POST /api/billing/plan
 * Switch or upgrade subscription plan tier (Owner only)
 */
billingRouter.post(
  "/plan",
  requireRole("owner"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const { planId } = req.body;

    if (!planId || typeof planId !== "string") {
      return res.status(400).json({ error: "Plan tier identifier is required (e.g. free, starter, pro, enterprise)" });
    }

    const result = await BillingService.updatePlan({
      tenantId,
      actorId,
      planId,
      ipAddress: req.ip,
    });

    res.json(result);
  })
);
