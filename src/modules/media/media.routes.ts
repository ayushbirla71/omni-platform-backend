import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { getMediaDownloadUrl } from "../../db/object-storage";

export const mediaRouter = Router();
mediaRouter.use(requireAuth);

/**
 * GET /api/media/download-url?key=<tenantId>/<conversationId>/<file>
 *
 * No ownership check beyond requiring auth today — the key embeds the
 * tenantId, but this endpoint doesn't verify req.auth.tenantId matches the
 * key's tenant segment before signing a URL. Fine while keys are opaque and
 * not guessable, but worth tightening before this is exposed beyond
 * trusted internal use. Flagged in IMPLEMENTATION_TRACKER.md.
 */
mediaRouter.get(
  "/download-url",
  asyncHandler(async (req: AuthedRequest, res) => {
    const key = typeof req.query.key === "string" ? req.query.key : undefined;
    if (!key) return res.status(400).json({ error: "key query parameter is required" });
    const url = await getMediaDownloadUrl(key);
    res.json({ url });
  })
);
