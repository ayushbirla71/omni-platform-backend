import { Router } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  createFlow,
  updateFlowDefinition,
  publishFlow,
  getFlow,
  listFlows,
  deleteFlow,
} from "./flows.service";
import { validateFlowDefinition, FlowDefinition } from "./flows.types";

export const flowsRouter = Router();
flowsRouter.use(requireAuth);

flowsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await listFlows(req.auth!.tenantId));
  })
);

flowsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const flow = await getFlow(req.auth!.tenantId, req.params.id);
    if (!flow) return res.sendStatus(404);
    res.json(flow);
  })
);

flowsRouter.post(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name, definition } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });

    const def: FlowDefinition = definition || { entryNodeId: "", nodes: [] };
    const errors = validateFlowDefinition(def);
    if (errors.length) return res.status(400).json({ errors });

    const flow = await createFlow({ tenantId: req.auth!.tenantId, name, definition: def });
    res.status(201).json(flow);
  })
);

flowsRouter.put(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { definition } = req.body || {};
    // Bug found during the route error-handling audit: validateFlowDefinition
    // assumes definition.nodes exists and throws a TypeError if `definition`
    // is missing entirely. Previously this crashed as an unhandled rejection
    // with no response ever sent (asyncHandler would now catch it regardless,
    // but this explicit check gives a real error message instead of a
    // generic 500).
    if (!definition || typeof definition !== "object") {
      return res.status(400).json({ error: "definition is required" });
    }

    const errors = validateFlowDefinition(definition);
    if (errors.length) return res.status(400).json({ errors });

    const flow = await updateFlowDefinition(req.auth!.tenantId, req.params.id, definition);
    if (!flow) {
      return res.status(404).json({ error: "Flow not found" });
    }
    res.json(flow);
  })
);

flowsRouter.delete(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const deleted = await deleteFlow(req.auth!.tenantId, req.params.id);
    if (!deleted) return res.sendStatus(404);
    res.json({ success: true });
  })
);

flowsRouter.post(
  "/:id/publish",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const existing = await getFlow(req.auth!.tenantId, req.params.id);
    if (!existing) return res.sendStatus(404);

    const errors = validateFlowDefinition(existing.definition, { isPublishing: true });
    if (errors.length) {
      return res.status(400).json({ error: "Cannot publish an invalid flow", errors });
    }

    const flow = await publishFlow(req.auth!.tenantId, req.params.id);
    res.json(flow);
  })
);
