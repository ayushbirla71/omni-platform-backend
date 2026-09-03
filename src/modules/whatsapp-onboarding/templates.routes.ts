import { Router } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { getChannelWithCredentials } from "../channels/channels.service";
import { listTemplates, createTemplate } from "./templates.service";

export const templatesRouter = Router();
templatesRouter.use(requireAuth);

async function loadWhatsAppChannelOrRespond(
  req: AuthedRequest,
  res: import("express").Response
): Promise<{ wabaId: string; accessToken: string; apiBaseUrl: string } | null> {
  const channel = await getChannelWithCredentials(req.auth!.tenantId, req.params.channelId);
  if (!channel) {
    res.sendStatus(404);
    return null;
  }
  if (channel.type !== "whatsapp" || !channel.credentials?.wabaId) {
    res.status(400).json({ error: "Templates are only available for WhatsApp channels onboarded via Embedded Signup" });
    return null;
  }
  return {
    wabaId: channel.credentials.wabaId,
    accessToken: channel.credentials.accessToken,
    apiBaseUrl: channel.credentials.apiBaseUrl || "https://graph.facebook.com/v21.0",
  };
}

templatesRouter.get(
  "/:channelId/templates",
  asyncHandler(async (req: AuthedRequest, res) => {
    const creds = await loadWhatsAppChannelOrRespond(req, res);
    if (!creds) return;
    res.json(await listTemplates(creds.wabaId, creds.accessToken, creds.apiBaseUrl));
  })
);

templatesRouter.post(
  "/:channelId/templates",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const creds = await loadWhatsAppChannelOrRespond(req, res);
    if (!creds) return;

    const { name, language, category, components } = req.body || {};
    if (!name || !language || !category || !Array.isArray(components)) {
      return res.status(400).json({ error: "name, language, category, and components are required" });
    }

    try {
      const result = await createTemplate(creds.wabaId, creds.accessToken, creds.apiBaseUrl, {
        name,
        language,
        category,
        components,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to create template" });
    }
  })
);
