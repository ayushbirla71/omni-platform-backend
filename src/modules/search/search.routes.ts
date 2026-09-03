import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { search } from "./search.service";

export const searchRouter = Router();
searchRouter.use(requireAuth);

/** GET /api/search?q=refund */
searchRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.status(400).json({ error: "q query parameter is required" });
    res.json(await search(req.auth!.tenantId, q));
  })
);
