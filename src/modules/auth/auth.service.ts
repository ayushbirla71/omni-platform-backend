import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { queryOne, withTransaction } from "../../db/pool";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

export interface AuthTokenPayload {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

export interface UserProfile {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  tenantName: string;
  tenantPlan: string;
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
}): Promise<{ token: string; tenantId: string; userId: string; role: string; email: string }> {
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
      `INSERT INTO users (tenant_id, email, password_hash, role, status)
       VALUES ($1, $2, $3, 'owner', 'active') RETURNING id`,
      [tenantId, email, passwordHash]
    );
    const userId = userResult.rows[0].id as string;

    return { tenantId, userId };
  });

  const token = signToken({ userId, tenantId, role: "owner", email });
  return { token, tenantId, userId, role: "owner", email };
}

export async function login(params: {
  email: string;
  password: string;
}): Promise<{ token: string; tenantId: string; userId: string; role: string; email: string }> {
  const { email, password } = params;

  const user = await queryOne<{
    id: string;
    tenant_id: string;
    email: string;
    password_hash: string;
    role: string;
    status: string;
  }>("SELECT id, tenant_id, email, password_hash, role, status FROM users WHERE lower(email) = lower($1)", [
    email,
  ]);

  if (!user) throw new AuthError("Invalid email or password");
  if (user.status === "deactivated") throw new AuthError("Account has been deactivated. Please contact your workspace administrator.");

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new AuthError("Invalid email or password");

  // Update last login timestamp asynchronously
  queryOne("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]).catch(() => {});

  const token = signToken({ userId: user.id, tenantId: user.tenant_id, role: user.role, email: user.email });
  return { token, tenantId: user.tenant_id, userId: user.id, role: user.role, email: user.email };
}

export async function getProfile(userId: string, tenantId: string): Promise<UserProfile | null> {
  const row = await queryOne<{
    id: string;
    tenant_id: string;
    email: string;
    name: string | null;
    role: string;
    status: string;
    last_login_at: string | null;
    created_at: string;
    tenant_name: string;
    tenant_plan: string;
  }>(
    `SELECT
       u.id,
       u.tenant_id,
       u.email,
       u.name,
       u.role,
       u.status,
       u.last_login_at,
       u.created_at,
       t.name AS tenant_name,
       t.plan AS tenant_plan
     FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1 AND u.tenant_id = $2`,
    [userId, tenantId]
  );

  if (!row) return null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    tenantName: row.tenant_name,
    tenantPlan: row.tenant_plan,
  };
}

export async function updateProfile(params: {
  userId: string;
  tenantId: string;
  name?: string;
  currentPassword?: string;
  newPassword?: string;
}): Promise<UserProfile> {
  const { userId, tenantId, name, currentPassword, newPassword } = params;

  const user = await queryOne<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE id = $1 AND tenant_id = $2",
    [userId, tenantId]
  );

  if (!user) throw new AuthError("User not found");

  if (newPassword) {
    if (!currentPassword) {
      throw new AuthError("Current password is required to change your password");
    }
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      throw new AuthError("Current password is incorrect");
    }
    if (newPassword.length < 6) {
      throw new AuthError("New password must be at least 6 characters");
    }
    const newHash = await bcrypt.hash(newPassword, 12);
    await queryOne(
      "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3",
      [newHash, userId, tenantId]
    );
  }

  if (name !== undefined) {
    await queryOne(
      "UPDATE users SET name = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3",
      [name.trim() || null, userId, tenantId]
    );
  }

  const updated = await getProfile(userId, tenantId);
  if (!updated) throw new AuthError("Failed to load updated profile");
  return updated;
}

function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}
