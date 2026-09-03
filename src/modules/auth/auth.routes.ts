import { Router } from "express";
import { signup, login, AuthError } from "./auth.service";

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
