import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../modules/auth/auth.service";
import { queryOne } from "../db/pool";

export interface AuthedRequest extends Request {
  auth?: { userId: string; tenantId: string; role: string };
}

/**
 * Every tenant-scoped route uses this. It never trusts a tenantId from the
 * request body/query — it always comes from the verified JWT, so one tenant
 * can never read or write another tenant's rows by tampering with a payload.
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length);
  } else if (typeof req.query.token === "string" && req.query.token && req.query.token !== "undefined" && req.query.token !== "null") {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    const payload = verifyToken(token);
    if (!payload?.userId || !payload?.tenantId) {
      return res.status(401).json({ error: "Invalid token payload" });
    }

    // Validate that the user and tenant exist in the database.
    // If the database was reset, seeded anew, or the tenant removed,
    // this gracefully returns 401 instead of triggering foreign key violation crashes (code 23503).
    const user = await queryOne<{ id: string; tenant_id: string; role: string }>(
      "SELECT id, tenant_id, role FROM users WHERE id = $1 AND tenant_id = $2",
      [payload.userId, payload.tenantId]
    );

    if (!user) {
      return res.status(401).json({ error: "User or tenant no longer exists. Please log in or sign up again." });
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
