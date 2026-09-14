import { Router, Response } from "express";
import { asyncHandler } from "../../middleware/async-handler";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { queryOne } from "../../db/pool";
import { SupportTicketService } from "./support-ticket.service";

export const supportTicketRouter = Router();

supportTicketRouter.use(requireAuth);

/**
 * Helper to fetch authenticated user's email and name
 */
async function getUserProfile(userId: string): Promise<{ email: string; name: string }> {
  const row = await queryOne<{ email: string; name: string }>(
    "SELECT email, name FROM users WHERE id = $1",
    [userId]
  );
  return {
    email: row?.email || "workspace_user@omni.local",
    name: row?.name || "Workspace Member",
  };
}

/**
 * GET /api/support/tickets
 * List current tenant workspace's tickets
 */
supportTicketRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const { status, search } = req.query;

    const tickets = await SupportTicketService.listTenantTickets(tenantId, {
      status: status as string,
      search: search as string,
    });

    res.json(tickets);
  })
);

/**
 * POST /api/support/tickets
 * Open a new support ticket
 */
supportTicketRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const userId = req.auth!.userId;
    const { subject, category, priority, message, attachments } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ error: "Subject and initial message are required" });
    }

    const user = await getUserProfile(userId);

    const ticket = await SupportTicketService.createTicket({
      tenantId,
      userId,
      userEmail: user.email,
      userName: user.name,
      subject,
      category,
      priority,
      message,
      attachments,
    });

    res.status(201).json(ticket);
  })
);

/**
 * GET /api/support/tickets/:id
 * Get single ticket details and conversation thread (strictly NO internal staff notes)
 */
supportTicketRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const ticket = await SupportTicketService.getTicketDetails(req.params.id, {
      tenantId,
      isPlatformStaff: false,
    });

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    res.json(ticket);
  })
);

/**
 * POST /api/support/tickets/:id/messages
 * Post a customer reply to the ticket
 */
supportTicketRouter.post(
  "/:id/messages",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const userId = req.auth!.userId;
    const { message, attachments } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message text cannot be blank" });
    }

    const user = await getUserProfile(userId);

    const reply = await SupportTicketService.addTicketMessage({
      ticketId: req.params.id,
      tenantId,
      senderType: "user",
      senderId: userId,
      senderName: user.name,
      senderEmail: user.email,
      message,
      attachments,
      isInternalNote: false, // Tenants cannot post internal notes
    });

    res.status(201).json(reply);
  })
);
