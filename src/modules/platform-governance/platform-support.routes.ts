import { Router, Response } from "express";
import { asyncHandler } from "../../middleware/async-handler";
import {
  requirePlatformAuth,
  requirePlatformRole,
  logPlatformAudit,
  PlatformAuthedRequest,
} from "../../middleware/platform-auth";
import { SupportTicketService } from "../support/support-ticket.service";

export const platformSupportRouter = Router();

platformSupportRouter.use(requirePlatformAuth);

/**
 * GET /api/platform/support/stats
 * Overview ticket counts (open, in-progress, pending, urgent, unassigned)
 */
platformSupportRouter.get(
  "/stats",
  asyncHandler(async (_req: PlatformAuthedRequest, res: Response) => {
    const stats = await SupportTicketService.getPlatformTicketStats();
    res.json(stats);
  })
);

/**
 * GET /api/platform/support/tickets
 * Master list of tickets across all tenants with search & filters
 */
platformSupportRouter.get(
  "/tickets",
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { status, priority, category, tenantId, assignedToStaffId, search, page, limit } = req.query;

    const result = await SupportTicketService.listPlatformTickets({
      status: status as string,
      priority: priority as string,
      category: category as string,
      tenantId: tenantId as string,
      assignedToStaffId: assignedToStaffId as string,
      search: search as string,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });

    res.json(result);
  })
);

/**
 * GET /api/platform/support/tickets/:id
 * Retrieve single ticket detail, public message thread, AND private internal staff notes
 */
platformSupportRouter.get(
  "/tickets/:id",
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const ticket = await SupportTicketService.getTicketDetails(req.params.id, {
      isPlatformStaff: true,
    });

    if (!ticket) {
      return res.status(404).json({ error: "Support ticket not found" });
    }

    res.json(ticket);
  })
);

/**
 * POST /api/platform/support/tickets/:id/messages
 * Post platform staff reply (public to customer OR private internal note)
 */
platformSupportRouter.post(
  "/tickets/:id/messages",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { message, attachments, isInternalNote } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message text cannot be blank" });
    }

    const staffUser = req.platformUser!;

    const reply = await SupportTicketService.addTicketMessage({
      ticketId: req.params.id,
      senderType: "platform_staff",
      senderId: staffUser.id,
      senderName: staffUser.name,
      senderEmail: staffUser.email,
      message,
      attachments,
      isInternalNote: Boolean(isInternalNote),
    });

    await logPlatformAudit({
      platformUser: staffUser,
      action: isInternalNote ? "support.add_internal_note" : "support.post_public_reply",
      targetType: "support_ticket",
      targetId: req.params.id,
      details: {
        isInternalNote: Boolean(isInternalNote),
        messageLength: message.length,
      },
      req,
    });

    res.status(201).json(reply);
  })
);

/**
 * PATCH /api/platform/support/tickets/:id
 * Update status, priority, category, or assign support staff
 */
platformSupportRouter.patch(
  "/tickets/:id",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { status, priority, category, assignedToStaffId, assignedToName } = req.body;
    const staffUser = req.platformUser!;

    const updated = await SupportTicketService.updateTicketStatusAndAssignment({
      ticketId: req.params.id,
      status,
      priority,
      category,
      assignedToStaffId,
      assignedToName,
      staffName: staffUser.name,
    });

    await logPlatformAudit({
      platformUser: staffUser,
      action: "support.update_ticket",
      targetType: "support_ticket",
      targetId: req.params.id,
      details: {
        status,
        priority,
        category,
        assignedToStaffId,
        assignedToName,
      },
      req,
    });

    res.json(updated);
  })
);
