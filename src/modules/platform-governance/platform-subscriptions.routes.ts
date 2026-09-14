import { Router, Response } from "express";
import { asyncHandler } from "../../middleware/async-handler";
import {
  requirePlatformAuth,
  requirePlatformRole,
  logPlatformAudit,
  PlatformAuthedRequest,
} from "../../middleware/platform-auth";
import {
  listWorkspaceSubscriptions,
  updateTenantSubscriptionLifecycle,
  recordSubscriptionPayment,
  listSubscriptionPayments,
} from "./platform-subscriptions.service";

export const platformSubscriptionsRouter = Router();

platformSubscriptionsRouter.use(requirePlatformAuth);

/**
 * GET /api/platform/subscriptions
 * List all workspace subscriptions with days remaining & quota metrics
 */
platformSubscriptionsRouter.get(
  "/",
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { search, status, planId, page, limit } = req.query;
    const result = await listWorkspaceSubscriptions({
      search: search as string,
      status: status as string,
      planId: planId as string,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    res.json(result);
  })
);

/**
 * PUT /api/platform/subscriptions/:tenantId
 * Modify a workspace subscription status, expiration, or quota limits
 */
platformSubscriptionsRouter.put(
  "/:tenantId",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { tenantId } = req.params;
    const {
      planId,
      planStatus,
      planExpiresAt,
      maxChannels,
      maxContacts,
      maxMonthlyMessages,
      maxMonthlyAiQueries,
    } = req.body;

    const updated = await updateTenantSubscriptionLifecycle({
      tenantId,
      planId,
      planStatus,
      planExpiresAt,
      maxChannels: maxChannels !== undefined ? Number(maxChannels) : undefined,
      maxContacts: maxContacts !== undefined ? Number(maxContacts) : undefined,
      maxMonthlyMessages: maxMonthlyMessages !== undefined ? Number(maxMonthlyMessages) : undefined,
      maxMonthlyAiQueries: maxMonthlyAiQueries !== undefined ? Number(maxMonthlyAiQueries) : undefined,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "subscription.lifecycle_update",
      targetType: "tenant_subscription",
      targetId: tenantId,
      details: {
        planId,
        planStatus,
        planExpiresAt,
        tenantName: updated.tenantName,
      },
      req,
    });

    res.json(updated);
  })
);

/**
 * POST /api/platform/subscriptions/:tenantId/renew
 * Quick renew a workspace subscription by N days or standard billing cycle
 */
platformSubscriptionsRouter.post(
  "/:tenantId/renew",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { tenantId } = req.params;
    const {
      planId,
      amount,
      billingCycle = "monthly",
      paymentMethod = "manual",
      sendReceipt = true,
      notes,
    } = req.body;

    if (!planId || amount === undefined) {
      return res.status(400).json({ error: "planId and amount are required to record renewal" });
    }

    const result = await recordSubscriptionPayment({
      tenantId,
      planId,
      amount: Number(amount),
      billingCycle,
      paymentMethod,
      notes: notes || "Manual administrative renewal via Platform Portal",
      sendReceiptEmail: Boolean(sendReceipt),
      staffId: req.platformUser?.id,
      staffName: req.platformUser?.name,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "subscription.renew",
      targetType: "tenant_subscription",
      targetId: tenantId,
      details: {
        invoiceNumber: result.payment.invoiceNumber,
        amount: result.payment.amount,
        planName: result.payment.planName,
        tenantName: result.subscription.tenantName,
      },
      req,
    });

    res.status(201).json(result);
  })
);

// ─────────────────────────────────────────────────────────────
// Payments Ledger Router
// ─────────────────────────────────────────────────────────────
export const platformPaymentsRouter = Router();
platformPaymentsRouter.use(requirePlatformAuth);

/**
 * GET /api/platform/payments
 * List payment transaction ledger & revenue metrics
 */
platformPaymentsRouter.get(
  "/",
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { tenantId, status, search, page, limit } = req.query;
    const result = await listSubscriptionPayments({
      tenantId: tenantId as string,
      status: status as string,
      search: search as string,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    res.json(result);
  })
);

/**
 * POST /api/platform/payments
 * Record a manual subscription payment / invoice entry
 */
platformPaymentsRouter.post(
  "/",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const {
      tenantId,
      planId,
      amount,
      currency,
      billingCycle,
      paymentMethod,
      transactionReference,
      periodStart,
      periodEnd,
      durationDays,
      notes,
      sendReceiptEmail,
    } = req.body;

    if (!tenantId || !planId || amount === undefined) {
      return res.status(400).json({ error: "tenantId, planId, and amount are required" });
    }

    const result = await recordSubscriptionPayment({
      tenantId,
      planId,
      amount: Number(amount),
      currency,
      billingCycle,
      paymentMethod,
      transactionReference,
      periodStart,
      periodEnd,
      durationDays: durationDays ? Number(durationDays) : undefined,
      notes,
      sendReceiptEmail: sendReceiptEmail !== undefined ? Boolean(sendReceiptEmail) : true,
      staffId: req.platformUser?.id,
      staffName: req.platformUser?.name,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "payment.record_entry",
      targetType: "platform_subscription_payment",
      targetId: result.payment.id,
      details: {
        invoiceNumber: result.payment.invoiceNumber,
        amount: result.payment.amount,
        tenantId,
        planId,
      },
      req,
    });

    res.status(201).json(result);
  })
);
