import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler";
import {
  requirePlatformAuth,
  requirePlatformRole,
  logPlatformAudit,
  PlatformAuthedRequest,
} from "../../middleware/platform-auth";
import {
  runSyntheticWebhookTest,
  runChannelHealthPing,
} from "./platform-testing.service";

export const platformTestingRouter = Router();

platformTestingRouter.use(requirePlatformAuth);

/**
 * POST /api/platform/testing/webhook-dispatch
 * Synthetic webhook dispatcher for QA / Platform Testers
 */
platformTestingRouter.post(
  "/webhook-dispatch",
  requirePlatformRole("super_admin", "platform_tester", "platform_dev"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const { channelType, mockSenderId, mockText } = req.body;

    const result = await runSyntheticWebhookTest({
      channelType: channelType || "whatsapp",
      mockSenderId,
      mockText,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "test.webhook_dispatch",
      targetType: "test_job",
      details: { channelType, durationMs: result.durationMs },
      req,
    });

    res.json(result);
  })
);

/**
 * GET /api/platform/testing/channel-pings
 * Channel connection diagnostics for QA / Testers
 */
platformTestingRouter.get(
  "/channel-pings",
  requirePlatformRole("super_admin", "platform_tester", "platform_dev", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const result = await runChannelHealthPing();
    res.json(result);
  })
);
