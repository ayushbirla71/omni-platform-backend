import { Router } from "express";
import multer from "multer";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { listConversations, getConversation, assignAgent, updateConversationStatus } from "./conversations.service";
import { listMessages, sendOutboundMessage } from "../messages/messages.service";
import { uploadMedia } from "../../db/object-storage";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

conversationsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const conversations = await listConversations(req.auth!.tenantId, status);
    res.json(conversations);
  })
);

conversationsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const conv = await getConversation(req.auth!.tenantId, req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    res.json(conv);
  })
);

conversationsRouter.get(
  "/:id/messages",
  asyncHandler(async (req: AuthedRequest, res) => {
    const messages = await listMessages(req.auth!.tenantId, req.params.id);
    res.json(messages);
  })
);

conversationsRouter.post(
  "/:id/messages",
  asyncHandler(async (req: AuthedRequest, res) => {
    const {
      text,
      type = "text",
      mediaUrl,
      mediaStorageKey,
      filename,
      templateName,
      templateLanguage,
      templateParams,
      headerType,
      headerValue,
    } = req.body || {};

    if (type === "text" && (!text || !text.trim())) {
      return res.status(400).json({ error: "text is required for text messages" });
    }

    try {
      const message = await sendOutboundMessage({
        tenantId: req.auth!.tenantId,
        conversationId: req.params.id,
        senderUserId: req.auth!.userId,
        text: text?.trim(),
        type,
        mediaUrl,
        mediaStorageKey,
        filename,
        templateName,
        templateLanguage,
        templateParams,
        headerType,
        headerValue,
      });
      res.status(201).json(message);
    } catch (err: any) {
      console.error("[conversations] Outbound send error:", err);
      const statusCode = typeof err?.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 400;
      res.status(statusCode).json({
        error: err?.message || "Failed to send message",
      });
    }
  })
);

/**
 * POST /api/conversations/:id/media
 * Upload a media file (image, document, audio, video, sticker) and send it directly.
 */
conversationsRouter.post(
  "/:id/media",
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const caption = typeof req.body.caption === "string" ? req.body.caption.trim() : typeof req.body.text === "string" ? req.body.text.trim() : undefined;
    const explicitType = req.body.type as string | undefined;

    // Detect media type from MIME type
    let messageType: "image" | "document" | "audio" | "video" | "sticker" = "document";
    const mime = file.mimetype.toLowerCase();
    if (explicitType && ["image", "document", "audio", "video", "sticker"].includes(explicitType)) {
      messageType = explicitType as any;
    } else if (mime.startsWith("image/webp")) {
      messageType = "sticker";
    } else if (mime.startsWith("image/")) {
      messageType = "image";
    } else if (mime.startsWith("video/")) {
      messageType = "video";
    } else if (mime.startsWith("audio/")) {
      messageType = "audio";
    }

    // Sanitize filename and construct unique S3 storage key
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storageKey = `${req.auth!.tenantId}/${req.params.id}/${Date.now()}-${sanitizedFilename}`;

    // Upload buffer to object storage
    await uploadMedia({
      key: storageKey,
      body: file.buffer,
      contentType: file.mimetype,
    });

    try {
      const message = await sendOutboundMessage({
        tenantId: req.auth!.tenantId,
        conversationId: req.params.id,
        senderUserId: req.auth!.userId,
        text: caption,
        type: messageType,
        mediaStorageKey: storageKey,
        filename: file.originalname,
      });

      res.status(201).json(message);
    } catch (err: any) {
      console.error("[conversations] Outbound media send error:", err);
      const statusCode = typeof err?.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 400;
      res.status(statusCode).json({
        error: err?.message || "Failed to send media message",
      });
    }
  })
);

/**
 * POST /api/conversations/:id/template
 * Send an approved WhatsApp template message (especially useful when 24h window has expired).
 */
conversationsRouter.post(
  "/:id/template",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { templateName, templateLanguage, templateParams, headerType, headerValue } = req.body || {};
    if (!templateName) {
      return res.status(400).json({ error: "templateName is required" });
    }

    try {
      const message = await sendOutboundMessage({
        tenantId: req.auth!.tenantId,
        conversationId: req.params.id,
        senderUserId: req.auth!.userId,
        type: "template",
        templateName,
        templateLanguage: templateLanguage || "en",
        templateParams: templateParams || {},
        headerType,
        headerValue,
      });
      res.status(201).json(message);
    } catch (err: any) {
      console.error("[conversations] Outbound template send error:", err);
      const statusCode = typeof err?.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 400;
      res.status(statusCode).json({
        error: err?.message || "Failed to send template message",
      });
    }
  })
);

conversationsRouter.post(
  "/:id/assign",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { agentUserId } = req.body || {};
    if (!agentUserId) return res.status(400).json({ error: "agentUserId is required" });
    await assignAgent(req.auth!.tenantId, req.params.id, agentUserId);
    res.status(204).send();
  })
);

conversationsRouter.patch(
  "/:id/status",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { status } = req.body || {};
    if (!status || !["open", "pending", "closed"].includes(status)) {
      return res.status(400).json({ error: "Valid status ('open', 'pending', 'closed') is required" });
    }
    await updateConversationStatus(req.auth!.tenantId, req.params.id, status);
    res.status(204).send();
  })
);
