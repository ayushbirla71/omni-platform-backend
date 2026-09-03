import { Router, Response } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { createCampaign, listCampaigns, getCampaign, deleteCampaign } from "./campaigns.service";
import { sendBroadcastNow } from "./campaign-sender";

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth);

campaignsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await listCampaigns(req.auth!.tenantId));
  })
);

campaignsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const campaign = await getCampaign(req.auth!.tenantId, req.params.id);
    if (!campaign) return res.sendStatus(404);
    res.json(campaign);
  })
);

campaignsRouter.delete(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const deleted = await deleteCampaign(req.auth!.tenantId, req.params.id);
    if (!deleted) return res.sendStatus(404);
    res.json({ success: true });
  })
);

/**
 * Body shape:
 *   broadcast: { channelId, name, type: "broadcast", tags?: string[], contactIds?: string[], definition: { text, tags? } }
 *   flow:      { channelId, name, type: "flow", tags?: string[], contactIds?: string[], definition: { flowId, tags? } }
 *   drip:      { channelId, name, type: "drip", tags?: string[], contactIds?: string[], definition: { steps: [{ delayHours, text }, ...] } }
 */
campaignsRouter.post(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { channelId, name, type, contactIds, tags, definition } = req.body || {};

    if (!channelId || !name || !type) {
      return res.status(400).json({ error: "channelId, name, and type are required" });
    }

    if (type !== "broadcast" && type !== "drip" && type !== "flow") {
      return res.status(400).json({ error: "type must be 'broadcast', 'flow', or 'drip'" });
    }

    if (type === "flow" && !definition?.flowId && !req.body.flowId) {
      return res.status(400).json({ error: "flow campaign requires a valid flowId in definition" });
    }

    if (type === "broadcast" && !definition?.text && !definition?.flowId && !req.body.flowId && !req.body.message) {
      return res.status(400).json({ error: "broadcast definition requires a text or flowId field" });
    }

    if (type === "drip" && (!Array.isArray(definition?.steps) || definition.steps.length === 0)) {
      return res.status(400).json({ error: "drip definition requires a non-empty steps array" });
    }

    const mergedDefinition = {
      ...definition,
      ...(type === "flow" && req.body.flowId ? { flowId: req.body.flowId } : {}),
      ...(type === "broadcast" && req.body.message ? { text: req.body.message } : {}),
      ...(tags ? { tags } : {}),
    };

    try {
      const campaign = await createCampaign({
        tenantId: req.auth!.tenantId,
        channelId,
        name,
        type,
        definition: mergedDefinition,
        contactIds,
        tags,
      });
      res.status(201).json(campaign);
    } catch (err: any) {
      if (err?.code === "23503") {
        return res.status(400).json({
          error: "channelId or one of contactIds does not refer to an existing record for this tenant",
        });
      }
      res.status(400).json({ error: err?.message || "Failed to create campaign" });
    }
  })
);

/**
 * Trigger send for broadcast or flow campaigns.
 */
campaignsRouter.post(
  "/:id/send",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    try {
      const result = await sendBroadcastNow(req.auth!.tenantId, req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to send campaign" });
    }
  })
);
