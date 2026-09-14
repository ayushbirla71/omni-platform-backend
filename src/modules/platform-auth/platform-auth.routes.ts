import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler";
import { requirePlatformAuth, PlatformAuthedRequest } from "../../middleware/platform-auth";
import {
  loginPlatformStaff,
  getPlatformStaffProfile,
  updatePlatformStaffProfile,
} from "./platform-auth.service";

export const platformAuthRouter = Router();

/**
 * POST /api/platform/auth/login
 * High-security staff login for internal platform staff.
 */
platformAuthRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const ipAddress = (req.headers["x-forwarded-for"] || req.socket.remoteAddress) as string;
    const userAgent = req.headers["user-agent"] as string;

    const result = await loginPlatformStaff({
      email: String(email).trim(),
      password: String(password),
      ipAddress,
      userAgent,
    });

    res.json(result);
  })
);

/**
 * GET /api/platform/auth/me
 * Authenticated session verification & profile retrieval for platform staff.
 */
platformAuthRouter.get(
  "/me",
  requirePlatformAuth,
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const profile = await getPlatformStaffProfile(req.platformUser!.id);
    if (!profile) {
      return res.status(404).json({ error: "Platform staff profile not found" });
    }
    res.json({ user: profile });
  })
);

/**
 * PUT /api/platform/auth/profile
 * Allows platform staff to update their display name and credentials.
 */
platformAuthRouter.put(
  "/profile",
  requirePlatformAuth,
  asyncHandler(async (req: PlatformAuthedRequest, res) => {
    const { name, currentPassword, newPassword } = req.body;

    const updated = await updatePlatformStaffProfile({
      platformUserId: req.platformUser!.id,
      name,
      currentPassword,
      newPassword,
    });

    res.json({ user: updated });
  })
);
