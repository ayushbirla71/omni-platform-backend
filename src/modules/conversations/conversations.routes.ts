import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { listConversations, assignAgent } from "./conversations.service";
import { listMessages, sendOutboundMessage } from "../messages/messages.service";

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
  "/:id/messages",
  asyncHandler(async (req: AuthedRequest, res) => {
    const messages = await listMessages(req.auth!.tenantId, req.params.id);
    res.json(messages);
  })
);

conversationsRouter.post(
  "/:id/messages",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "text is required" });
    try {
      const message = await sendOutboundMessage({
        tenantId: req.auth!.tenantId,
        conversationId: req.params.id,
        senderUserId: req.auth!.userId,
        text: text.trim(),
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

conversationsRouter.post(
  "/:id/assign",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { agentUserId } = req.body || {};
    if (!agentUserId) return res.status(400).json({ error: "agentUserId is required" });
    // agentUserId is a foreign key to users(id) — an unknown id now falls
    // through to the global handler's 23503 mapping instead of hanging.
    await assignAgent(req.auth!.tenantId, req.params.id, agentUserId);
    res.status(204).send();
  })
);
