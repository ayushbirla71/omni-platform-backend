import { query, queryOne, withTransaction } from "../../db/pool";
import { emailService } from "../email/email.service";
import { logger } from "../../utils/logger";
import { emitRealtimeEvent } from "../realtime/websocket.service";

export interface SupportTicketItem {
  id: string;
  ticketNumber: string;
  tenantId: string;
  tenantName?: string;
  createdByUserId: string | null;
  createdByEmail: string;
  createdByName: string;
  subject: string;
  category: "billing" | "technical" | "channel_integration" | "account" | "feature_request" | "general" | string;
  priority: "low" | "medium" | "high" | "urgent" | string;
  status: "open" | "in_progress" | "pending_customer" | "resolved" | "closed" | string;
  assignedToStaffId: string | null;
  assignedToName: string | null;
  lastReplyAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  messageCount?: number;
  internalNoteCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketMessageItem {
  id: string;
  ticketId: string;
  senderType: "user" | "platform_staff";
  senderId: string | null;
  senderName: string;
  senderEmail: string;
  message: string;
  attachments: any[];
  isInternalNote: boolean;
  createdAt: string;
}

export interface SupportTicketDetail extends SupportTicketItem {
  messages: SupportTicketMessageItem[];
}

export class SupportTicketService {
  /**
   * Generates next human-friendly sequential ticket number, e.g. "TICK-1042"
   */
  public static async getNextTicketNumber(): Promise<string> {
    try {
      const res = await queryOne<{ next_val: string }>("SELECT nextval('support_ticket_seq') as next_val");
      return `TICK-${res?.next_val || Date.now().toString().slice(-4)}`;
    } catch {
      return `TICK-${Math.floor(1000 + Math.random() * 9000)}`;
    }
  }

  /**
   * Tenant-initiated ticket creation
   */
  public static async createTicket(params: {
    tenantId: string;
    userId?: string;
    userEmail: string;
    userName: string;
    subject: string;
    category?: string;
    priority?: string;
    message: string;
    attachments?: any[];
  }): Promise<SupportTicketItem> {
    const {
      tenantId,
      userId,
      userEmail,
      userName,
      subject,
      category = "general",
      priority = "medium",
      message,
      attachments = [],
    } = params;

    const ticketNumber = await this.getNextTicketNumber();

    const row = await queryOne<any>(
      `INSERT INTO support_tickets (
         ticket_number, tenant_id, created_by_user_id, created_by_email, created_by_name,
         subject, category, priority, status, last_reply_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', now())
       RETURNING id, ticket_number, tenant_id, created_by_user_id, created_by_email, created_by_name,
                 subject, category, priority, status, assigned_to_staff_id, assigned_to_name,
                 last_reply_at, resolved_at, closed_at, created_at, updated_at`,
      [ticketNumber, tenantId, userId || null, userEmail.trim(), userName.trim(), subject.trim(), category, priority]
    );

    // Insert first message thread
    await queryOne<any>(
      `INSERT INTO support_ticket_messages (
         ticket_id, sender_type, sender_id, sender_name, sender_email,
         message, attachments, is_internal_note
       ) VALUES ($1, 'user', $2, $3, $4, $5, $6::jsonb, false)
       RETURNING id`,
      [row.id, userId || null, userName.trim(), userEmail.trim(), message.trim(), JSON.stringify(attachments)]
    );

    // Send confirmation email asynchronously
    emailService
      .sendTicketCreatedConfirmation({
        to: userEmail,
        userName,
        ticketNumber,
        subject,
        category,
        priority,
        message,
      })
      .catch((err) => {
        logger.error("[SupportTicket] Failed to dispatch ticket confirmation email:", err);
      });

    const ticketItem: SupportTicketItem = {
      id: row.id,
      ticketNumber: row.ticket_number,
      tenantId: row.tenant_id,
      createdByUserId: row.created_by_user_id,
      createdByEmail: row.created_by_email,
      createdByName: row.created_by_name,
      subject: row.subject,
      category: row.category,
      priority: row.priority,
      status: row.status,
      assignedToStaffId: row.assigned_to_staff_id,
      assignedToName: row.assigned_to_name,
      lastReplyAt: row.last_reply_at,
      resolvedAt: row.resolved_at,
      closedAt: row.closed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Emit real-time creation event to both tenant portal and platform staff
    emitRealtimeEvent(row.tenant_id, "support_ticket:created", {
      ticket: ticketItem,
    }).catch(() => {});

    return ticketItem;
  }

  /**
   * List tickets for a specific tenant (tenant workspace portal view)
   */
  public static async listTenantTickets(
    tenantId: string,
    filters: { status?: string; search?: string } = {}
  ): Promise<SupportTicketItem[]> {
    const conditions: string[] = ["st.tenant_id = $1"];
    const params: any[] = [tenantId];
    let idx = 2;

    if (filters.status && filters.status !== "all") {
      conditions.push(`st.status = $${idx++}`);
      params.push(filters.status);
    }

    if (filters.search && filters.search.trim()) {
      conditions.push(`(st.subject ILIKE $${idx} OR st.ticket_number ILIKE $${idx})`);
      params.push(`%${filters.search.trim()}%`);
      idx++;
    }

    const sql = `
      SELECT
        st.id,
        st.ticket_number,
        st.tenant_id,
        st.created_by_user_id,
        st.created_by_email,
        st.created_by_name,
        st.subject,
        st.category,
        st.priority,
        st.status,
        st.assigned_to_staff_id,
        st.assigned_to_name,
        st.last_reply_at,
        st.resolved_at,
        st.closed_at,
        st.created_at,
        st.updated_at,
        (SELECT count(*) FROM support_ticket_messages stm WHERE stm.ticket_id = st.id AND stm.is_internal_note = false) as message_count
      FROM support_tickets st
      WHERE ${conditions.join(" AND ")}
      ORDER BY st.last_reply_at DESC, st.created_at DESC
    `;

    const rows = await query<any>(sql, params);
    return rows.map((r) => ({
      id: r.id,
      ticketNumber: r.ticket_number,
      tenantId: r.tenant_id,
      createdByUserId: r.created_by_user_id,
      createdByEmail: r.created_by_email,
      createdByName: r.created_by_name,
      subject: r.subject,
      category: r.category,
      priority: r.priority,
      status: r.status,
      assignedToStaffId: r.assigned_to_staff_id,
      assignedToName: r.assigned_to_name,
      lastReplyAt: r.last_reply_at,
      resolvedAt: r.resolved_at,
      closedAt: r.closed_at,
      messageCount: parseInt(r.message_count || "0", 10),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Get single ticket and conversation history.
   * If isPlatformStaff is false, strictly omit internal staff notes!
   */
  public static async getTicketDetails(
    ticketId: string,
    options: { tenantId?: string; isPlatformStaff?: boolean } = {}
  ): Promise<SupportTicketDetail | null> {
    const { tenantId, isPlatformStaff = false } = options;

    const conditions = ["(st.id::text = $1 OR st.ticket_number = $1)"];
    const params: any[] = [ticketId];

    if (tenantId) {
      conditions.push("st.tenant_id = $2");
      params.push(tenantId);
    }

    const ticketRow = await queryOne<any>(
      `SELECT
         st.id,
         st.ticket_number,
         st.tenant_id,
         t.name as tenant_name,
         st.created_by_user_id,
         st.created_by_email,
         st.created_by_name,
         st.subject,
         st.category,
         st.priority,
         st.status,
         st.assigned_to_staff_id,
         st.assigned_to_name,
         st.last_reply_at,
         st.resolved_at,
         st.closed_at,
         st.created_at,
         st.updated_at
       FROM support_tickets st
       JOIN tenants t ON t.id = st.tenant_id
       WHERE ${conditions.join(" AND ")}`,
      params
    );

    if (!ticketRow) return null;

    // Messages query
    const msgConditions = ["ticket_id = $1"];
    if (!isPlatformStaff) {
      // Zero-Internal-Note Exposure to Tenant
      msgConditions.push("is_internal_note = false");
    }

    const msgRows = await query<any>(
      `SELECT id, ticket_id, sender_type, sender_id, sender_name, sender_email,
              message, attachments, is_internal_note, created_at
       FROM support_ticket_messages
       WHERE ${msgConditions.join(" AND ")}
       ORDER BY created_at ASC`,
      [ticketRow.id]
    );

    const messages: SupportTicketMessageItem[] = msgRows.map((m) => ({
      id: m.id,
      ticketId: m.ticket_id,
      senderType: m.sender_type,
      senderId: m.sender_id,
      senderName: m.sender_name,
      senderEmail: m.sender_email,
      message: m.message,
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      isInternalNote: Boolean(m.is_internal_note),
      createdAt: m.created_at,
    }));

    return {
      id: ticketRow.id,
      ticketNumber: ticketRow.ticket_number,
      tenantId: ticketRow.tenant_id,
      tenantName: ticketRow.tenant_name,
      createdByUserId: ticketRow.created_by_user_id,
      createdByEmail: ticketRow.created_by_email,
      createdByName: ticketRow.created_by_name,
      subject: ticketRow.subject,
      category: ticketRow.category,
      priority: ticketRow.priority,
      status: ticketRow.status,
      assignedToStaffId: ticketRow.assigned_to_staff_id,
      assignedToName: ticketRow.assigned_to_name,
      lastReplyAt: ticketRow.last_reply_at,
      resolvedAt: ticketRow.resolved_at,
      closedAt: ticketRow.closed_at,
      messageCount: messages.length,
      createdAt: ticketRow.created_at,
      updatedAt: ticketRow.updated_at,
      messages,
    };
  }

  /**
   * Post message reply or private internal staff note
   */
  public static async addTicketMessage(params: {
    ticketId: string;
    tenantId?: string;
    senderType: "user" | "platform_staff";
    senderId?: string;
    senderName: string;
    senderEmail: string;
    message: string;
    attachments?: any[];
    isInternalNote?: boolean;
  }): Promise<SupportTicketMessageItem> {
    const {
      ticketId,
      tenantId,
      senderType,
      senderId,
      senderName,
      senderEmail,
      message,
      attachments = [],
      isInternalNote = false,
    } = params;

    const ticket = await this.getTicketDetails(ticketId, {
      tenantId,
      isPlatformStaff: senderType === "platform_staff",
    });

    if (!ticket) throw new Error("Support ticket not found");

    const row = await queryOne<any>(
      `INSERT INTO support_ticket_messages (
         ticket_id, sender_type, sender_id, sender_name, sender_email,
         message, attachments, is_internal_note
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING id, ticket_id, sender_type, sender_id, sender_name, sender_email,
                 message, attachments, is_internal_note, created_at`,
      [
        ticket.id,
        senderType,
        senderId || null,
        senderName.trim(),
        senderEmail.trim(),
        message.trim(),
        JSON.stringify(attachments),
        isInternalNote,
      ]
    );

    // Update ticket timestamps and status
    if (!isInternalNote) {
      let newStatus = ticket.status;
      if (senderType === "platform_staff") {
        if (ticket.status === "open") newStatus = "in_progress";
      } else if (senderType === "user") {
        if (ticket.status === "resolved" || ticket.status === "closed") newStatus = "open";
      }

      await query(
        "UPDATE support_tickets SET last_reply_at = now(), status = $1, updated_at = now() WHERE id = $2",
        [newStatus, ticket.id]
      );

      // Email notification for public replies
      if (senderType === "platform_staff") {
        emailService
          .sendTicketReplyNotification({
            to: ticket.createdByEmail,
            recipientName: ticket.createdByName,
            ticketNumber: ticket.ticketNumber,
            subject: ticket.subject,
            senderName,
            isStaffReply: true,
            message,
          })
          .catch((err) => {
            logger.error("[SupportTicket] Failed to dispatch staff reply email:", err);
          });
      }
    }

    const messageItem: SupportTicketMessageItem = {
      id: row.id,
      ticketId: row.ticket_id,
      senderType: row.sender_type,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderEmail: row.sender_email,
      message: row.message,
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      isInternalNote: Boolean(row.is_internal_note),
      createdAt: row.created_at,
    };

    // Emit real-time message event (Internal note filtered automatically by WebSocket gateway for tenants)
    emitRealtimeEvent(ticket.tenantId, "support_ticket:message", {
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      message: messageItem,
      status: isInternalNote ? ticket.status : (senderType === "platform_staff" && ticket.status === "open" ? "in_progress" : ticket.status),
      lastReplyAt: row.created_at,
      isInternalNote: Boolean(row.is_internal_note),
    }).catch(() => {});

    return messageItem;
  }

  /**
   * Platform staff status & assignment modifier
   */
  public static async updateTicketStatusAndAssignment(params: {
    ticketId: string;
    status?: "open" | "in_progress" | "pending_customer" | "resolved" | "closed" | string;
    priority?: "low" | "medium" | "high" | "urgent" | string;
    category?: string;
    assignedToStaffId?: string | null;
    assignedToName?: string | null;
    staffName?: string;
  }): Promise<SupportTicketDetail> {
    const { ticketId, status, priority, category, assignedToStaffId, assignedToName, staffName } = params;

    const ticket = await this.getTicketDetails(ticketId, { isPlatformStaff: true });
    if (!ticket) throw new Error("Support ticket not found");

    const updates: string[] = ["updated_at = now()"];
    const values: any[] = [];
    let idx = 1;

    let wasJustResolved = false;

    if (status !== undefined) {
      updates.push(`status = $${idx++}`);
      values.push(status);

      if (status === "resolved" && ticket.status !== "resolved") {
        updates.push("resolved_at = now()");
        wasJustResolved = true;
      } else if (status === "closed" && ticket.status !== "closed") {
        updates.push("closed_at = now()");
      }
    }

    if (priority !== undefined) {
      updates.push(`priority = $${idx++}`);
      values.push(priority);
    }

    if (category !== undefined) {
      updates.push(`category = $${idx++}`);
      values.push(category);
    }

    if (assignedToStaffId !== undefined) {
      updates.push(`assigned_to_staff_id = $${idx++}`);
      values.push(assignedToStaffId || null);

      updates.push(`assigned_to_name = $${idx++}`);
      values.push(assignedToName || null);
    }

    values.push(ticket.id);
    const sql = `UPDATE support_tickets SET ${updates.join(", ")} WHERE id = $${idx}`;
    await query(sql, values);

    if (wasJustResolved) {
      emailService
        .sendTicketResolvedNotification({
          to: ticket.createdByEmail,
          userName: ticket.createdByName,
          ticketNumber: ticket.ticketNumber,
          subject: ticket.subject,
          resolvedByName: staffName || "Platform Support Team",
        })
        .catch((err) => {
          logger.error("[SupportTicket] Failed to dispatch ticket resolved email:", err);
        });
    }

    const updated = await this.getTicketDetails(ticket.id, { isPlatformStaff: true });

    // Emit real-time status & assignment updates to both tenant and platform staff
    if (updated) {
      emitRealtimeEvent(ticket.tenantId, "support_ticket:updated", {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        status: updated.status,
        priority: updated.priority,
        category: updated.category,
        assignedToStaffId: updated.assignedToStaffId,
        assignedToName: updated.assignedToName,
        lastReplyAt: updated.lastReplyAt,
        resolvedAt: updated.resolvedAt,
        closedAt: updated.closedAt,
      }).catch(() => {});
    }

    return updated!;
  }

  /**
   * Platform staff master ticket query across all tenants
   */
  public static async listPlatformTickets(filters: {
    status?: string;
    priority?: string;
    category?: string;
    tenantId?: string;
    assignedToStaffId?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {}): Promise<{
    tickets: SupportTicketItem[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(100, Math.max(1, filters.limit || 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filters.status && filters.status !== "all") {
      conditions.push(`st.status = $${idx++}`);
      params.push(filters.status);
    }

    if (filters.priority && filters.priority !== "all") {
      conditions.push(`st.priority = $${idx++}`);
      params.push(filters.priority);
    }

    if (filters.category && filters.category !== "all") {
      conditions.push(`st.category = $${idx++}`);
      params.push(filters.category);
    }

    if (filters.tenantId && filters.tenantId !== "all") {
      conditions.push(`st.tenant_id = $${idx++}`);
      params.push(filters.tenantId);
    }

    if (filters.assignedToStaffId && filters.assignedToStaffId !== "all") {
      if (filters.assignedToStaffId === "unassigned") {
        conditions.push("st.assigned_to_staff_id IS NULL");
      } else {
        conditions.push(`st.assigned_to_staff_id = $${idx++}`);
        params.push(filters.assignedToStaffId);
      }
    }

    if (filters.search && filters.search.trim()) {
      conditions.push(
        `(st.ticket_number ILIKE $${idx} OR st.subject ILIKE $${idx} OR st.created_by_email ILIKE $${idx} OR t.name ILIKE $${idx})`
      );
      params.push(`%${filters.search.trim()}%`);
      idx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRes = await queryOne<{ count: string }>(
      `SELECT count(*) FROM support_tickets st JOIN tenants t ON t.id = st.tenant_id ${whereClause}`,
      params
    );
    const total = parseInt(countRes?.count || "0", 10);

    const sql = `
      SELECT
        st.id,
        st.ticket_number,
        st.tenant_id,
        t.name as tenant_name,
        st.created_by_user_id,
        st.created_by_email,
        st.created_by_name,
        st.subject,
        st.category,
        st.priority,
        st.status,
        st.assigned_to_staff_id,
        st.assigned_to_name,
        st.last_reply_at,
        st.resolved_at,
        st.closed_at,
        st.created_at,
        st.updated_at,
        (SELECT count(*) FROM support_ticket_messages stm WHERE stm.ticket_id = st.id AND stm.is_internal_note = false) as message_count,
        (SELECT count(*) FROM support_ticket_messages stm WHERE stm.ticket_id = st.id AND stm.is_internal_note = true) as internal_note_count
      FROM support_tickets st
      JOIN tenants t ON t.id = st.tenant_id
      ${whereClause}
      ORDER BY
        CASE st.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END ASC,
        st.last_reply_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    params.push(limit, offset);
    const rows = await query<any>(sql, params);

    const tickets: SupportTicketItem[] = rows.map((r) => ({
      id: r.id,
      ticketNumber: r.ticket_number,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      createdByUserId: r.created_by_user_id,
      createdByEmail: r.created_by_email,
      createdByName: r.created_by_name,
      subject: r.subject,
      category: r.category,
      priority: r.priority,
      status: r.status,
      assignedToStaffId: r.assigned_to_staff_id,
      assignedToName: r.assigned_to_name,
      lastReplyAt: r.last_reply_at,
      resolvedAt: r.resolved_at,
      closedAt: r.closed_at,
      messageCount: parseInt(r.message_count || "0", 10),
      internalNoteCount: parseInt(r.internal_note_count || "0", 10),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return {
      tickets,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Quick support metrics for governance dashboard
   */
  public static async getPlatformTicketStats(): Promise<{
    open: number;
    inProgress: number;
    pendingCustomer: number;
    resolved: number;
    urgent: number;
    unassigned: number;
  }> {
    const res = await queryOne<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open') as open_count,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress_count,
        COUNT(*) FILTER (WHERE status = 'pending_customer') as pending_count,
        COUNT(*) FILTER (WHERE status = 'resolved' OR status = 'closed') as resolved_count,
        COUNT(*) FILTER (WHERE priority = 'urgent' AND status NOT IN ('resolved', 'closed')) as urgent_count,
        COUNT(*) FILTER (WHERE assigned_to_staff_id IS NULL AND status NOT IN ('resolved', 'closed')) as unassigned_count
      FROM support_tickets
    `);

    return {
      open: parseInt(res?.open_count || "0", 10),
      inProgress: parseInt(res?.in_progress_count || "0", 10),
      pendingCustomer: parseInt(res?.pending_count || "0", 10),
      resolved: parseInt(res?.resolved_count || "0", 10),
      urgent: parseInt(res?.urgent_count || "0", 10),
      unassigned: parseInt(res?.unassigned_count || "0", 10),
    };
  }
}
