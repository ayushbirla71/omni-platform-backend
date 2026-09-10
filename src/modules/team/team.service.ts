import bcrypt from "bcrypt";
import { query, queryOne } from "../../db/pool";
import { AuditService } from "../audit/audit.service";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "team-service" });

export interface TeamMember {
  id: string;
  tenant_id: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "agent" | "viewer";
  status: "active" | "deactivated" | "invited";
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export class TeamService {
  /**
   * Lists all team members in a workspace tenant.
   */
  public static async listMembers(tenantId: string): Promise<TeamMember[]> {
    return query<TeamMember>(
      `SELECT id, tenant_id, email, name, role, status, last_login_at, created_at, updated_at
       FROM users
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [tenantId]
    );
  }

  /**
   * Invites / adds a new team member to the workspace with a specific role.
   */
  public static async inviteMember(params: {
    tenantId: string;
    actorId?: string;
    actorEmail?: string;
    email: string;
    name?: string;
    role: "admin" | "agent" | "viewer";
    password?: string;
    ipAddress?: string;
  }): Promise<TeamMember> {
    const email = params.email.trim().toLowerCase();

    // Check existing email
    const existing = await queryOne<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = lower($1)",
      [email]
    );
    if (existing) {
      throw new Error("A user with this email address already exists.");
    }

    const defaultPassword = params.password || "OmniTeam2026!";
    const passwordHash = await bcrypt.hash(defaultPassword, 12);

    const user = await queryOne<TeamMember>(
      `INSERT INTO users (tenant_id, email, name, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id, tenant_id, email, name, role, status, last_login_at, created_at, updated_at`,
      [params.tenantId, email, params.name || null, passwordHash, params.role]
    );

    if (!user) {
      throw new Error("Failed to create team member");
    }

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.actorId,
      userEmail: params.actorEmail,
      action: "user.invite",
      resourceType: "user",
      resourceId: user.id,
      details: { email: user.email, name: user.name, role: user.role },
      ipAddress: params.ipAddress,
    });

    log.info("Invited new team member", { tenantId: params.tenantId, userId: user.id, email: user.email, role: user.role });

    return user;
  }

  /**
   * Updates a team member's role (owner, admin, agent, viewer).
   */
  public static async updateRole(params: {
    tenantId: string;
    actorId?: string;
    actorEmail?: string;
    targetUserId: string;
    newRole: "owner" | "admin" | "agent" | "viewer";
    ipAddress?: string;
  }): Promise<TeamMember> {
    const targetUser = await queryOne<TeamMember>(
      "SELECT id, tenant_id, email, name, role, status FROM users WHERE id = $1 AND tenant_id = $2",
      [params.targetUserId, params.tenantId]
    );

    if (!targetUser) {
      throw new Error("Team member not found");
    }

    // If demoting an owner, ensure there is at least one other owner remaining
    if (targetUser.role === "owner" && params.newRole !== "owner") {
      const ownerCountRes = await queryOne<{ count: string }>(
        "SELECT count(*) as count FROM users WHERE tenant_id = $1 AND role = 'owner'",
        [params.tenantId]
      );
      const ownerCount = parseInt(ownerCountRes?.count || "0", 10);
      if (ownerCount <= 1) {
        throw new Error("Cannot demote the last remaining workspace owner");
      }
    }

    const updated = await queryOne<TeamMember>(
      `UPDATE users
       SET role = $1, updated_at = now()
       WHERE id = $2 AND tenant_id = $3
       RETURNING id, tenant_id, email, name, role, status, last_login_at, created_at, updated_at`,
      [params.newRole, params.targetUserId, params.tenantId]
    );

    if (!updated) {
      throw new Error("Failed to update member role");
    }

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.actorId,
      userEmail: params.actorEmail,
      action: "user.role_change",
      resourceType: "user",
      resourceId: updated.id,
      details: { email: updated.email, oldRole: targetUser.role, newRole: updated.role },
      ipAddress: params.ipAddress,
    });

    log.info("Updated team member role", {
      tenantId: params.tenantId,
      userId: updated.id,
      oldRole: targetUser.role,
      newRole: updated.role,
    });

    return updated;
  }

  /**
   * Toggles member activation status ('active' | 'deactivated').
   */
  public static async updateStatus(params: {
    tenantId: string;
    actorId?: string;
    actorEmail?: string;
    targetUserId: string;
    status: "active" | "deactivated";
    ipAddress?: string;
  }): Promise<TeamMember> {
    if (params.targetUserId === params.actorId) {
      throw new Error("You cannot deactivate your own account");
    }

    const targetUser = await queryOne<TeamMember>(
      "SELECT id, tenant_id, email, name, role, status FROM users WHERE id = $1 AND tenant_id = $2",
      [params.targetUserId, params.tenantId]
    );

    if (!targetUser) {
      throw new Error("Team member not found");
    }

    if (targetUser.role === "owner" && params.status === "deactivated") {
      const activeOwnerCount = await queryOne<{ count: string }>(
        "SELECT count(*) as count FROM users WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'",
        [params.tenantId]
      );
      if (parseInt(activeOwnerCount?.count || "0", 10) <= 1) {
        throw new Error("Cannot deactivate the only active workspace owner");
      }
    }

    const updated = await queryOne<TeamMember>(
      `UPDATE users
       SET status = $1, updated_at = now()
       WHERE id = $2 AND tenant_id = $3
       RETURNING id, tenant_id, email, name, role, status, last_login_at, created_at, updated_at`,
      [params.status, params.targetUserId, params.tenantId]
    );

    if (!updated) {
      throw new Error("Failed to update user status");
    }

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.actorId,
      userEmail: params.actorEmail,
      action: "user.status_change",
      resourceType: "user",
      resourceId: updated.id,
      details: { email: updated.email, status: updated.status },
      ipAddress: params.ipAddress,
    });

    return updated;
  }

  /**
   * Deletes a team member from the workspace.
   */
  public static async removeMember(params: {
    tenantId: string;
    actorId?: string;
    actorEmail?: string;
    targetUserId: string;
    ipAddress?: string;
  }): Promise<boolean> {
    if (params.targetUserId === params.actorId) {
      throw new Error("You cannot remove your own account from the workspace");
    }

    const targetUser = await queryOne<TeamMember>(
      "SELECT id, tenant_id, email, name, role FROM users WHERE id = $1 AND tenant_id = $2",
      [params.targetUserId, params.tenantId]
    );

    if (!targetUser) {
      return false;
    }

    if (targetUser.role === "owner") {
      const ownerCountRes = await queryOne<{ count: string }>(
        "SELECT count(*) as count FROM users WHERE tenant_id = $1 AND role = 'owner'",
        [params.tenantId]
      );
      if (parseInt(ownerCountRes?.count || "0", 10) <= 1) {
        throw new Error("Cannot delete the only owner of the workspace");
      }
    }

    await query("DELETE FROM users WHERE id = $1 AND tenant_id = $2", [params.targetUserId, params.tenantId]);

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.actorId,
      userEmail: params.actorEmail,
      action: "user.remove",
      resourceType: "user",
      resourceId: params.targetUserId,
      details: { email: targetUser.email, role: targetUser.role },
      ipAddress: params.ipAddress,
    });

    log.info("Removed team member", { tenantId: params.tenantId, userId: params.targetUserId, email: targetUser.email });

    return true;
  }
}
