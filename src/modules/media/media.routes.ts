import { Router, Request, Response } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { getMediaDownloadUrl, getMediaObject, uploadMedia } from "../../db/object-storage";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max limit
});

export const mediaRouter = Router();

/**
 * POST /api/media/upload
 *
 * Authenticated endpoint for uploading media assets (images, videos, documents, audio)
 * for WhatsApp templates, broadcasts, flow nodes, and attachments.
 * Saves file to S3 / MinIO object storage under tenant namespace and returns direct & download URLs.
 */
mediaRouter.post(
  "/upload",
  requireAuth,
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file provided for upload" });
    }

    const tenantId = req.auth!.tenantId;
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${tenantId}/templates/${Date.now()}-${uuidv4().slice(0, 8)}_${sanitizedFilename}`;

    await uploadMedia({
      key,
      body: file.buffer,
      contentType: file.mimetype || "application/octet-stream",
    });

    // Generate presigned download URL valid for 7 days for Meta / WhatsApp API delivery
    let downloadUrl: string | undefined;
    try {
      downloadUrl = await getMediaDownloadUrl(key, 7 * 86400);
    } catch {
      downloadUrl = undefined;
    }

    const fileUrl = `/api/media/file?key=${encodeURIComponent(key)}`;

    res.status(201).json({
      success: true,
      key,
      url: downloadUrl || fileUrl,
      downloadUrl: downloadUrl || fileUrl,
      fileUrl,
      filename: file.originalname,
      contentType: file.mimetype,
      size: file.size,
    });
  })
);

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
