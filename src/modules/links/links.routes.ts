import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { getChannelWithCredentials } from "../channels/channels.service";
import { buildDeepLink, generateQrCodeDataUrl, UnsupportedChannelError } from "./links.service";

export const linksRouter = Router();
linksRouter.use(requireAuth);

/** GET /api/channels/:channelId/deep-link?text=Hi+there */
linksRouter.get(
  "/:channelId/deep-link",
  asyncHandler(async (req: AuthedRequest, res) => {
    const channel = await getChannelWithCredentials(req.auth!.tenantId, req.params.channelId);
    if (!channel) return res.sendStatus(404);

    const prefilledText = typeof req.query.text === "string" ? req.query.text : undefined;

    try {
      const link = buildDeepLink(channel, prefilledText);
      const qrCodeDataUrl = await generateQrCodeDataUrl(link);
      res.json({ link, qrCodeDataUrl });
    } catch (err) {
      if (err instanceof UnsupportedChannelError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to build deep link" });
    }
  })
);
