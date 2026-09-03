import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { createDeal, listDeals, updateDealStage, getPipelineSummary } from "./deals.service";

export const dealsRouter = Router();
dealsRouter.use(requireAuth);

dealsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const stage = typeof req.query.stage === "string" ? req.query.stage : undefined;
    res.json(await listDeals(req.auth!.tenantId, stage));
  })
);

dealsRouter.get(
  "/pipeline-summary",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await getPipelineSummary(req.auth!.tenantId));
  })
);

dealsRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { contactId, title, stage, value } = req.body || {};
    if (!contactId || !title) {
      return res.status(400).json({ error: "contactId and title are required" });
    }
    // Kept as its own try/catch for a specific message; the global handler's
    // generic 23503 mapping would work too, but "contactId does not refer
    // to an existing contact" is more useful than "refers to a record that
    // does not exist" here.
    try {
      const deal = await createDeal({ tenantId: req.auth!.tenantId, contactId, title, stage, value });
      res.status(201).json(deal);
    } catch (err: any) {
      if (err?.code === "23503") {
        return res.status(400).json({ error: "contactId does not refer to an existing contact" });
      }
      throw err; // let asyncHandler -> global handler deal with anything else
    }
  })
);

dealsRouter.patch(
  "/:id/stage",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { stage } = req.body || {};
    if (!stage) return res.status(400).json({ error: "stage is required" });
    const deal = await updateDealStage(req.auth!.tenantId, req.params.id, stage);
    if (!deal) return res.sendStatus(404);
    res.json(deal);
  })
);
