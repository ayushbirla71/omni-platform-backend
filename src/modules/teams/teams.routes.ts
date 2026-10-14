import { Router, Response } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { httpError, isUuid } from "../../utils/http-error";
import {
  listTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  setTeamMembers,
} from "./teams.service";

export const teamsRouter = Router();
teamsRouter.use(requireAuth);

const actorOf = (req: AuthedRequest) => ({
  userId: req.auth!.userId,
  email: req.auth!.email,
  ipAddress: req.ip,
});

function teamIdOf(req: AuthedRequest): string {
  if (!isUuid(req.params.id)) throw httpError(400, "Invalid team id");
  return req.params.id;
}

/** Any signed-in user can list teams (the inbox needs them for its assign menus). */
teamsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await listTeams(req.auth!.tenantId));
  })
);

teamsRouter.post(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { name, description } = req.body || {};
    res.status(201).json(await createTeam(req.auth!.tenantId, actorOf(req), { name, description }));
  })
);

teamsRouter.patch(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { name, description } = req.body || {};
    res.json(
      await updateTeam(req.auth!.tenantId, actorOf(req), teamIdOf(req), { name, description })
    );
  })
);

teamsRouter.delete(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    await deleteTeam(req.auth!.tenantId, actorOf(req), teamIdOf(req));
    res.status(204).send();
  })
);

teamsRouter.put(
  "/:id/members",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { userIds } = req.body || {};
    res.json(await setTeamMembers(req.auth!.tenantId, actorOf(req), teamIdOf(req), userIds));
  })
);
