import { query, queryOne } from "../../db/pool";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "audit-service" });

export interface AuditLogItem {
  id: string;
  tenant_id: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, any>;
  ip_address: string | null;
  created_at: string;
}

export interface RecordAuditParams {
  tenantId: string;
  userId?: string | null;
  userEmail?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  details?: Record<string, any>;
  ipAddress?: string | null;
}

export class AuditService {
  /**
   * Records an audit log event for administrative actions, security, and compliance.
   */
  public static async record(params: RecordAuditParams): Promise<void> {
    try {
      await query(
        `INSERT INTO audit_logs (tenant_id, user_id, user_email, action, resource_type, resource_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          params.tenantId,
          params.userId || null,
          params.userEmail || null,
          params.action,
          params.resourceType,
          params.resourceId || null,
          JSON.stringify(params.details || {}),
          params.ipAddress || null,
        ]
      );
    } catch (err: any) {
      log.warn("Failed to record audit log", { error: err.message, action: params.action });
    }
  }

  /**
   * Retrieves audit logs for a tenant with pagination and optional filtering.
   */
  public static async list(
    tenantId: string,
    options: {
      action?: string;
      resourceType?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ logs: AuditLogItem[]; total: number }> {
    const limit = Math.min(Math.max(options.limit || 50, 1), 200);
    const offset = Math.max(options.offset || 0, 0);

    const conditions: string[] = ["tenant_id = $1"];
    const values: any[] = [tenantId];
    let paramIndex = 2;

    if (options.action) {
      conditions.push(`action = $${paramIndex++}`);
      values.push(options.action);
    }

    if (options.resourceType) {
      conditions.push(`resource_type = $${paramIndex++}`);
      values.push(options.resourceType);
    }

    const whereClause = conditions.join(" AND ");

    const totalRes = await queryOne<{ count: string }>(
      `SELECT count(*) as count FROM audit_logs WHERE ${whereClause}`,
      values
    );

    const logs = await query<AuditLogItem>(
      `SELECT id, tenant_id, user_id, user_email, action, resource_type, resource_id, details, ip_address, created_at
       FROM audit_logs
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );

    return {
      logs,
      total: parseInt(totalRes?.count || "0", 10),
    };
  }

  /**
   * Gets summary counts for security & audit dashboard
   */
  public static async getStats(tenantId: string): Promise<{
    totalEvents: number;
    recent24h: number;
    actionsSummary: Record<string, number>;
  }> {
    const totalRes = await queryOne<{ count: string }>(
      "SELECT count(*) as count FROM audit_logs WHERE tenant_id = $1",
      [tenantId]
    );

    const recentRes = await queryOne<{ count: string }>(
      "SELECT count(*) as count FROM audit_logs WHERE tenant_id = $1 AND created_at >= now() - interval '24 hours'",
      [tenantId]
    );

    const actionRows = await query<{ action: string; count: string }>(
      `SELECT action, count(*) as count
       FROM audit_logs
       WHERE tenant_id = $1
       GROUP BY action
       ORDER BY count DESC
       LIMIT 10`,
      [tenantId]
    );

    const actionsSummary: Record<string, number> = {};
    for (const row of actionRows) {
      actionsSummary[row.action] = parseInt(row.count, 10);
    }

    return {
      totalEvents: parseInt(totalRes?.count || "0", 10),
      recent24h: parseInt(recentRes?.count || "0", 10),
      actionsSummary,
    };
  }
}
