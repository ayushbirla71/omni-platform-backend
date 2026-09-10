import crypto from "crypto";
import { query, queryOne } from "../../db/pool";
import { AuditService } from "../audit/audit.service";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "api-keys-service" });

export interface ApiKeyRecord {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  is_active: boolean;
  created_at: string;
}

export interface CreatedApiKeyResult extends ApiKeyRecord {
  secretKey: string; // Only returned upon creation
}

export class ApiKeysService {
  /**
   * Generates a new cryptographically secure API key for developer access.
   */
  public static async createKey(params: {
    tenantId: string;
    userId?: string;
    userEmail?: string;
    name: string;
    scopes?: string[];
    expiresInDays?: number;
    ipAddress?: string;
  }): Promise<CreatedApiKeyResult> {
    const rawSecret = `omni_live_${crypto.randomBytes(24).toString("hex")}`;
    const keyPrefix = rawSecret.slice(0, 16) + "...";
    const keyHash = crypto.createHash("sha256").update(rawSecret).digest("hex");

    let expiresAt: Date | null = null;
    if (params.expiresInDays && params.expiresInDays > 0) {
      expiresAt = new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000);
    }

    const scopes = params.scopes && params.scopes.length > 0 ? params.scopes : ["*"];

    const created = await queryOne<ApiKeyRecord>(
      `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, expires_at, created_by, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, created_by, is_active, created_at`,
      [
        params.tenantId,
        params.name,
        keyPrefix,
        keyHash,
        JSON.stringify(scopes),
        expiresAt ? expiresAt.toISOString() : null,
        params.userId || null,
      ]
    );

    if (!created) {
      throw new Error("Failed to create API key in database");
    }

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.userId,
      userEmail: params.userEmail,
      action: "apikey.create",
      resourceType: "api_key",
      resourceId: created.id,
      details: { name: params.name, prefix: keyPrefix, scopes },
      ipAddress: params.ipAddress,
    });

    log.info("Created new developer API key", { tenantId: params.tenantId, keyId: created.id, name: params.name });

    return {
      ...created,
      secretKey: rawSecret,
    };
  }

  /**
   * Lists all active and inactive API keys for a tenant.
   */
  public static async listKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    return query<ApiKeyRecord>(
      `SELECT id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, created_by, is_active, created_at
       FROM api_keys
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [tenantId]
    );
  }

  /**
   * Revokes/deletes an API key.
   */
  public static async revokeKey(params: {
    tenantId: string;
    apiKeyId: string;
    userId?: string;
    userEmail?: string;
    ipAddress?: string;
  }): Promise<boolean> {
    const existing = await queryOne<ApiKeyRecord>(
      "SELECT id, name, key_prefix FROM api_keys WHERE id = $1 AND tenant_id = $2",
      [params.apiKeyId, params.tenantId]
    );

    if (!existing) {
      return false;
    }

    await query("DELETE FROM api_keys WHERE id = $1 AND tenant_id = $2", [params.apiKeyId, params.tenantId]);

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.userId,
      userEmail: params.userEmail,
      action: "apikey.revoke",
      resourceType: "api_key",
      resourceId: params.apiKeyId,
      details: { name: existing.name, prefix: existing.key_prefix },
      ipAddress: params.ipAddress,
    });

    log.info("Revoked API key", { tenantId: params.tenantId, keyId: params.apiKeyId });
    return true;
  }

  /**
   * Validates an API key from an HTTP request header (e.g. Bearer omni_live_...)
   */
  public static async validateKey(rawKey: string): Promise<{
    id: string;
    tenantId: string;
    scopes: string[];
  } | null> {
    if (!rawKey.startsWith("omni_live_")) {
      return null;
    }

    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    const record = await queryOne<{
      id: string;
      tenant_id: string;
      scopes: string[];
      expires_at: string | null;
      is_active: boolean;
    }>(
      `SELECT id, tenant_id, scopes, expires_at, is_active
       FROM api_keys
       WHERE key_hash = $1 AND is_active = true`,
      [keyHash]
    );

    if (!record) {
      return null;
    }

    // Check expiration
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      return null;
    }

    // Touch last_used_at asynchronously
    query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [record.id]).catch((err) =>
      log.warn("Failed to update last_used_at for API key", { error: err.message })
    );

    return {
      id: record.id,
      tenantId: record.tenant_id,
      scopes: record.scopes || ["*"],
    };
  }
}
