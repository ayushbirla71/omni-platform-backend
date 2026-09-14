import bcrypt from "bcrypt";
import { query, queryOne } from "../../db/pool";
import { PlatformRole } from "../platform-auth/platform-auth.service";

export interface PlatformStaffListItem {
  id: string;
  email: string;
  name: string;
  role: PlatformRole;
  status: "active" | "suspended" | "deactivated";
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PlatformAuditLogItem {
  id: string;
  platformUserId: string | null;
  platformUserEmail: string;
  platformUserRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, any>;
  ipAddress: string | null;
  createdAt: string;
}

export async function listPlatformStaff(): Promise<PlatformStaffListItem[]> {
  const rows = await query<any>(
    `SELECT id, email, name, role, status, mfa_enabled, last_login_at, created_at
     FROM platform_users
     ORDER BY created_at DESC`
  );

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    status: r.status,
    mfaEnabled: r.mfa_enabled,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  }));
}

export async function createPlatformStaff(params: {
  email: string;
  password: string;
  name: string;
  role: PlatformRole;
}): Promise<PlatformStaffListItem> {
  const { email, password, name, role } = params;

  const existing = await queryOne("SELECT id FROM platform_users WHERE lower(email) = lower($1)", [email]);
  if (existing) {
    throw new Error("A platform user with this email already exists");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const row = await queryOne<any>(
    `INSERT INTO platform_users (email, password_hash, name, role, status, permissions)
     VALUES ($1, $2, $3, $4, 'active', '[]')
     RETURNING id, email, name, role, status, mfa_enabled, last_login_at, created_at`,
    [email.trim(), passwordHash, name.trim(), role]
  );

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    mfaEnabled: row.mfa_enabled,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export async function updatePlatformStaff(params: {
  staffId: string;
  role?: PlatformRole;
  status?: "active" | "suspended" | "deactivated";
  name?: string;
}): Promise<PlatformStaffListItem> {
  const { staffId, role, status, name } = params;

  const updates: string[] = ["updated_at = now()"];
  const values: any[] = [];
  let idx = 1;

  if (role !== undefined) {
    updates.push(`role = $${idx++}`);
    values.push(role);
  }
  if (status !== undefined) {
    updates.push(`status = $${idx++}`);
    values.push(status);
  }
  if (name !== undefined) {
    updates.push(`name = $${idx++}`);
    values.push(name.trim());
  }

  values.push(staffId);
  const sql = `UPDATE platform_users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id, email, name, role, status, mfa_enabled, last_login_at, created_at`;

  const row = await queryOne<any>(sql, values);
  if (!row) throw new Error("Platform staff member not found");

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    mfaEnabled: row.mfa_enabled,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export async function listPlatformAuditLogs(filters: {
  action?: string;
  targetType?: string;
  tenantId?: string;
  limit?: number;
}): Promise<PlatformAuditLogItem[]> {
  const limit = Math.min(200, Math.max(1, filters.limit || 50));
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.action) {
    conditions.push(`action = $${idx++}`);
    params.push(filters.action);
  }
  if (filters.targetType) {
    conditions.push(`target_type = $${idx++}`);
    params.push(filters.targetType);
  }
  if (filters.tenantId && filters.tenantId !== "all") {
    conditions.push(`(target_id = $${idx} OR details->>'tenantId' = $${idx})`);
    params.push(filters.tenantId);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const sql = `
    SELECT id, platform_user_id, platform_user_email, platform_user_role, action, target_type, target_id, details, ip_address, created_at
    FROM platform_audit_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT $${idx}
  `;

  const rows = await query<any>(sql, params);

  return rows.map((r) => ({
    id: r.id,
    platformUserId: r.platform_user_id,
    platformUserEmail: r.platform_user_email,
    platformUserRole: r.platform_user_role,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    details: r.details || {},
    ipAddress: r.ip_address,
    createdAt: r.created_at,
  }));
}
