import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { queryOne, withTransaction } from "../../db/pool";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

export interface AuthTokenPayload {
  userId: string;
  tenantId: string;
  role: string;
}

export class AuthError extends Error {}

/**
 * Signup creates a brand new tenant plus its first user (the "owner").
 * Every other user is created later via an invite flow scoped to an
 * existing tenant_id (not implemented in this pass).
 */
export async function signup(params: {
  tenantName: string;
  email: string;
  password: string;
}): Promise<{ token: string; tenantId: string; userId: string }> {
  const { tenantName, email, password } = params;

  const existing = await queryOne(
    "SELECT id FROM users WHERE lower(email) = lower($1)",
    [email]
  );
  if (existing) {
    throw new AuthError("An account with this email already exists");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const { tenantId, userId } = await withTransaction(async (client) => {
    const tenantResult = await client.query(
      "INSERT INTO tenants (name) VALUES ($1) RETURNING id",
      [tenantName]
    );
    const tenantId = tenantResult.rows[0].id as string;

    const userResult = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'owner') RETURNING id`,
      [tenantId, email, passwordHash]
    );
    const userId = userResult.rows[0].id as string;

    return { tenantId, userId };
  });

  const token = signToken({ userId, tenantId, role: "owner" });
  return { token, tenantId, userId };
}

export async function login(params: {
  email: string;
  password: string;
}): Promise<{ token: string; tenantId: string; userId: string; role: string }> {
  const { email, password } = params;

  const user = await queryOne<{
    id: string;
    tenant_id: string;
    password_hash: string;
    role: string;
  }>("SELECT id, tenant_id, password_hash, role FROM users WHERE lower(email) = lower($1)", [
    email,
  ]);

  if (!user) throw new AuthError("Invalid email or password");

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new AuthError("Invalid email or password");

  const token = signToken({ userId: user.id, tenantId: user.tenant_id, role: user.role });
  return { token, tenantId: user.tenant_id, userId: user.id, role: user.role };
}

function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}
