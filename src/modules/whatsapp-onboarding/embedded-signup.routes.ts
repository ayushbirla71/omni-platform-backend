import { Router } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  completeEmbeddedSignup,
  getOnboardingCapacity,
  EmbeddedSignupError,
} from "./embedded-signup.service";

export const whatsappOnboardingRouter = Router();
whatsappOnboardingRouter.use(requireAuth);

/**
 * Public-safe config the frontend needs to launch Meta's Embedded Signup JS
 * SDK (FB.login with the WhatsApp Embedded Signup extension). The app id
 * and config id are not secrets — the app SECRET never leaves the backend.
 */
whatsappOnboardingRouter.get("/config", (_req, res) => {
  res.json({
    appId: process.env.META_APP_ID || null,
    configId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || null,
  });
});

whatsappOnboardingRouter.get(
  "/capacity",
  asyncHandler(async (_req: AuthedRequest, res) => {
    res.json(await getOnboardingCapacity());
  })
);

/**
 * Called by the frontend once the tenant completes the Embedded Signup
 * flow. Meta's JS SDK delivers { code, wabaId, phoneNumberId } via a
 * postMessage event — the frontend just forwards them here.
 */
whatsappOnboardingRouter.post(
  "/callback",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { code, wabaId, phoneNumberId, displayName } = req.body || {};
    if (!code) {
      return res
        .status(400)
        .json({ error: "Meta authorization code is required" });
    }

    const capacity = await getOnboardingCapacity();
    if (capacity.remaining <= 0) {
      return res.status(429).json({
        error: `Onboarding capacity reached: ${capacity.used}/${capacity.limit} in the last ${capacity.windowDays} days`,
      });
    }

    try {
      const channel = await completeEmbeddedSignup({
        tenantId: req.auth!.tenantId,
        code,
        wabaId,
        phoneNumberId,
        displayName,
      });
      const { credentials: _omit, ...safe } = channel;
      res.status(201).json(safe);
    } catch (err) {
      if (err instanceof EmbeddedSignupError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  })
);
