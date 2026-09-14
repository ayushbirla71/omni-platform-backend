import { Router, Request, Response } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { getMediaDownloadUrl, getMediaObject } from "../../db/object-storage";

export const mediaRouter = Router();

/**
 * GET /api/media/download-url?key=<tenantId>/<conversationId>/<file>
 *
 * Generates presigned S3 / MinIO download URL.
 */
mediaRouter.get(
  "/download-url",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const key = typeof req.query.key === "string" ? req.query.key : undefined;
    if (!key) return res.status(400).json({ error: "key query parameter is required" });
    const url = await getMediaDownloadUrl(key);
    res.json({ url, downloadUrl: url });
  })
);

/**
 * GET /api/media/file?key=<tenantId>/<conversationId>/<file>
 *
 * Streams media file directly through API backend.
 * Supports public webchat attachments, cross-origin embeds, and authenticated streams.
 */
mediaRouter.get(
  "/file",
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    const key = typeof req.query.key === "string" ? req.query.key : undefined;
    if (!key) return res.status(400).json({ error: "key query parameter is required" });

    try {
      const { body, contentType, contentLength } = await getMediaObject(key);
      res.setHeader("Content-Type", contentType);
      if (contentLength) res.setHeader("Content-Length", contentLength);
      res.setHeader("Cache-Control", "public, max-age=86400");

      if (body && typeof body.pipe === "function") {
        body.pipe(res);
      } else if (body && typeof body.transformToByteArray === "function") {
        const bytes = await body.transformToByteArray();
        res.send(Buffer.from(bytes));
      } else {
        res.status(404).json({ error: "Media not found" });
      }
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: "File not found in media storage" });
      }
      res.status(500).json({ error: err?.message || "Failed to retrieve media file" });
    }
  })
);
