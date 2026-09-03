import { Router } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { createChannel, listChannels, setDefaultFlow, updateChannel } from "./channels.service";

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

channelsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const channels = await listChannels(req.auth!.tenantId);
    res.json(channels);
  })
);

channelsRouter.post(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { type, displayName, credentials } = req.body || {};
    if (!type || !displayName) {
      return res.status(400).json({ error: "type and displayName are required" });
    }
    // type is CHECK-constrained to a fixed set — an invalid value now falls
    // through to the global handler's 23514 mapping instead of hanging.
    const channel = await createChannel({
      tenantId: req.auth!.tenantId,
      type,
      displayName,
      credentials: credentials || {},
    });
    const { credentials: _omit, ...safe } = channel;
    res.status(201).json(safe);
  })
);

channelsRouter.post(
  "/:id/default-flow",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { flowId } = req.body || {};
    // flowId is a foreign key to flows(id) — an unknown id now falls
    // through to the global handler's 23503 mapping instead of hanging.
    await setDefaultFlow(req.auth!.tenantId, req.params.id, flowId ?? null);
    res.sendStatus(204);
  })
);

channelsRouter.patch(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { displayName, credentials, status } = req.body || {};
    const channel = await updateChannel(req.auth!.tenantId, req.params.id, {
      displayName,
      credentials,
      status,
    });
    if (!channel) return res.sendStatus(404);
    const { credentials: _omit, ...safe } = channel;
    res.json(safe);
  })
);
