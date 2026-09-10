import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  getWebhookSubscription,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookDeliveryLogs,
  executeWebhookDelivery,
} from "./outgoing-webhooks.service";

export const outgoingWebhooksRouter = Router();
outgoingWebhooksRouter.use(requireAuth);

outgoingWebhooksRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const subs = await listWebhookSubscriptions(req.auth!.tenantId);
    res.json(subs);
  })
);

outgoingWebhooksRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name, url, secret, events } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    if (!url || typeof url !== "string" || !url.startsWith("http")) {
      return res.status(400).json({ error: "A valid HTTP(S) url is required" });
    }

    const sub = await createWebhookSubscription({
      tenantId: req.auth!.tenantId,
      name: name.trim(),
      url: url.trim(),
      secret: secret?.trim(),
      events: Array.isArray(events) ? events : undefined,
    });

    res.status(201).json(sub);
  })
);

outgoingWebhooksRouter.get(
  "/deliveries",
  asyncHandler(async (req: AuthedRequest, res) => {
    const limit = Number(req.query.limit) || 50;
    const logs = await listWebhookDeliveryLogs(req.auth!.tenantId, undefined, limit);
    res.json(logs);
  })
);

outgoingWebhooksRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const sub = await getWebhookSubscription(req.auth!.tenantId, req.params.id);
    if (!sub) return res.status(404).json({ error: "Webhook subscription not found" });
    res.json(sub);
  })
);

outgoingWebhooksRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name, url, secret, events, is_active } = req.body || {};
    const updated = await updateWebhookSubscription(req.auth!.tenantId, req.params.id, {
      name,
      url,
      secret,
      events,
      is_active,
    });

    if (!updated) return res.status(404).json({ error: "Webhook subscription not found" });
    res.json(updated);
  })
);

outgoingWebhooksRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const deleted = await deleteWebhookSubscription(req.auth!.tenantId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Webhook subscription not found" });
    res.status(204).send();
  })
);

outgoingWebhooksRouter.post(
  "/:id/test",
  asyncHandler(async (req: AuthedRequest, res) => {
    const sub = await getWebhookSubscription(req.auth!.tenantId, req.params.id);
    if (!sub) return res.status(404).json({ error: "Webhook subscription not found" });

    const pingPayload = {
      event: "ping",
      message: "OmniPlatform outgoing webhook test delivery",
      tenant_id: req.auth!.tenantId,
      timestamp: new Date().toISOString(),
    };

    const result = await executeWebhookDelivery(sub, "ping", pingPayload, 1);
    res.json({
      success: result.success,
      statusCode: result.statusCode,
      error: result.error,
      message: result.success
        ? `Successfully sent ping event to ${sub.url} (HTTP ${result.statusCode})`
        : `Ping delivery failed (${result.error || `HTTP ${result.statusCode}`})`,
    });
  })
);

outgoingWebhooksRouter.get(
  "/:id/deliveries",
  asyncHandler(async (req: AuthedRequest, res) => {
    const limit = Number(req.query.limit) || 50;
    const logs = await listWebhookDeliveryLogs(req.auth!.tenantId, req.params.id, limit);
    res.json(logs);
  })
);
