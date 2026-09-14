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
 * POST /api/billing/checkout
 * Initializes a SaaS subscription upgrade checkout session (Stripe / Razorpay / Sandbox)
 */
billingRouter.post(
  "/checkout",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const actorEmail = req.auth!.email;
    const { planId, billingCycle = "monthly", gateway = "stripe", successUrl, cancelUrl } = req.body;

    if (!planId || typeof planId !== "string") {
      return res.status(400).json({ error: "Plan tier identifier is required" });
    }

    const session = await BillingService.createCheckoutSession({
      tenantId,
      actorId,
      actorEmail,
      planId,
      billingCycle,
      gateway,
      successUrl,
      cancelUrl,
    });

    res.json(session);
  })
);

/**
 * POST /api/billing/verify-payment
 * Verifies SaaS subscription payment and applies upgrade with immutable invoice record
 */
billingRouter.post(
  "/verify-payment",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const actorEmail = req.auth!.email;
    const { planId, billingCycle = "monthly", gateway = "stripe", paymentReference } = req.body;

    if (!planId) {
      return res.status(400).json({ error: "Plan identifier is required" });
    }

    const result = await BillingService.verifyPaymentAndUpgrade({
      tenantId,
      actorId,
      actorEmail,
      planId,
      billingCycle,
      gateway,
      paymentReference: paymentReference || `ref_${Date.now()}`,
      ipAddress: req.ip,
    });

    res.json(result);
  })
);

/**
 * POST /api/billing/plan
 * Direct plan update for internal/free adjustments (Owner only)
 */
billingRouter.post(
  "/plan",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const actorEmail = req.auth!.email;
    const { planId } = req.body;

    if (!planId || typeof planId !== "string") {
      return res.status(400).json({ error: "Plan tier identifier is required (e.g. free, starter, pro, enterprise)" });
    }

    const result = await BillingService.updatePlan({
      tenantId,
      actorId,
      actorEmail,
      planId,
      ipAddress: req.ip,
    });

    res.json(result);
  })
);

/**
 * GET /api/billing/invoices
 * Get payment and invoice history for the current tenant workspace
 */
billingRouter.get(
  "/invoices",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const invoices = await BillingService.getInvoices(tenantId);
    res.json({ invoices });
  })
);
