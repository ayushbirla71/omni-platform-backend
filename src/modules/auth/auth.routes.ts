import { Router } from "express";
import { signup, login, getProfile, updateProfile, AuthError } from "./auth.service";
import { requireAuth, AuthedRequest } from "../../middleware/auth";

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const { tenantName, email, password } = req.body || {};
  if (!tenantName || !email || !password) {
    return res.status(400).json({ error: "tenantName, email and password are required" });
  }
  try {
    const result = await signup({ tenantName, email, password });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AuthError) return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    const result = await login({ email, password });
    res.json(result);
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * GET /api/auth/me
 * Returns detailed profile of the currently authenticated user.
 */
authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.auth?.userId;
    const tenantId = req.auth?.tenantId;
    if (!userId || !tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const profile = await getProfile(userId, tenantId);
    if (!profile) {
      return res.status(404).json({ error: "User profile not found" });
    }

    res.json(profile);
  } catch (err) {
    console.error("[authRouter] /me error:", err);
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

/**
 * PATCH /api/auth/profile
 * Updates the user's name and/or password.
 */
authRouter.patch("/profile", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.auth?.userId;
    const tenantId = req.auth?.tenantId;
    if (!userId || !tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { name, currentPassword, newPassword } = req.body || {};
    const updated = await updateProfile({
      userId,
      tenantId,
      name,
      currentPassword,
      newPassword,
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("[authRouter] /profile error:", err);
    res.status(500).json({ error: "Failed to update user profile" });
  }
});
