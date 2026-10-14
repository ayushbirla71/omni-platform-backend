import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  search,
  SearchType,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_QUERY_LENGTH,
} from "./search.service";

export const searchRouter = Router();
searchRouter.use(requireAuth);

const SEARCH_TYPES: readonly SearchType[] = ["all", "messages", "contacts"];

function parseLimit(raw: unknown): number {
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return SEARCH_DEFAULT_LIMIT;
  return Math.min(parsed, SEARCH_MAX_LIMIT);
}

/** GET /api/search?q=refund&type=all|messages|contacts&limit=20 → { messages, contacts } */
searchRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.status(400).json({ error: "q query parameter is required" });
    if (q.length > SEARCH_MAX_QUERY_LENGTH) {
      return res
        .status(400)
        .json({ error: `q must be at most ${SEARCH_MAX_QUERY_LENGTH} characters` });
    }

    const rawType = req.query.type;
    const type = rawType === undefined ? "all" : rawType;
    if (typeof type !== "string" || !SEARCH_TYPES.includes(type as SearchType)) {
      return res.status(400).json({ error: `type must be one of: ${SEARCH_TYPES.join(", ")}` });
    }

    res.json(
      await search(req.auth!.tenantId, q, {
        type: type as SearchType,
        limit: parseLimit(req.query.limit),
      })
    );
  })
);
