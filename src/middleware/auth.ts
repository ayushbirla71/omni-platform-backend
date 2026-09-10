import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../modules/auth/auth.service";
import { ApiKeysService } from "../modules/api-keys/api-keys.service";
import { queryOne } from "../db/pool";

export interface AuthedRequest extends Request {
  auth?: {
    userId: string;
    tenantId: string;
    role: string;
    apiKeyId?: string;
    scopes?: string[];
  };
}

/**
 * Every tenant-scoped route uses this. It supports:
 * 1. User JWT tokens (Bearer eyJ...)
 * 2. Developer API keys (Bearer omni_live_...)
 *
 * It never trusts a tenantId from request body/query — it always comes from
 * the verified authentication token, guaranteeing cross-tenant isolation.
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length).trim();
  } else if (typeof req.query.token === "string" && req.query.token && req.query.token !== "undefined" && req.query.token !== "null") {
    token = req.query.token.trim();
  }

  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  // 1. Check if token is a developer API Key
  if (token.startsWith("omni_live_")) {
    try {
      const apiKey = await ApiKeysService.validateKey(token);
      if (!apiKey) {
        return res.status(401).json({ error: "Invalid, expired, or inactive API key" });
      }

      req.auth = {
        userId: `apikey:${apiKey.id}`,
        tenantId: apiKey.tenantId,
        role: "admin", // API Keys run with admin-level programmatic capabilities
        apiKeyId: apiKey.id,
        scopes: apiKey.scopes,
      };
      return next();
    } catch (err) {
      return res.status(401).json({ error: "Failed to authenticate API key" });
    }
  }

  // 2. Validate standard JWT token
  try {
    const payload = verifyToken(token);
    if (!payload?.userId || !payload?.tenantId) {
      return res.status(401).json({ error: "Invalid token payload" });
    }

    // Validate that the user and tenant exist in the database.
    const user = await queryOne<{ id: string; tenant_id: string; role: string; status: string }>(
      "SELECT id, tenant_id, role, status FROM users WHERE id = $1 AND tenant_id = $2",
      [payload.userId, payload.tenantId]
    );

    if (!user) {
      return res.status(401).json({ error: "User or tenant no longer exists. Please log in or sign up again." });
    }

    if (user.status === "deactivated") {
      return res.status(403).json({ error: "Account has been deactivated. Please contact your workspace owner." });
    }

    req.auth = {
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
    };
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
