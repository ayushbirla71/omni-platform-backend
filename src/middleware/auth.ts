import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../modules/auth/auth.service";

export interface AuthedRequest extends Request {
  auth?: { userId: string; tenantId: string; role: string };
}

/**
 * Every tenant-scoped route uses this. It never trusts a tenantId from the
 * request body/query — it always comes from the verified JWT, so one tenant
 * can never read or write another tenant's rows by tampering with a payload.
 */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    const payload = verifyToken(header.slice("Bearer ".length));
    req.auth = payload;
    next();
  } catch {
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
