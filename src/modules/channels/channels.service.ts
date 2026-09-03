import { query, queryOne } from "../../db/pool";

export interface Channel {
  id: string;
  tenant_id: string;
  type: string;
  display_name: string;
  credentials: Record<string, any>;
  status: string;
  created_at: string;
}

export async function createChannel(params: {
  tenantId: string;
  type: string;
  displayName: string;
  credentials: Record<string, any>;
}): Promise<Channel> {
  const { tenantId, type, displayName, credentials } = params;
  const row = await queryOne<Channel>(
    `INSERT INTO channels (tenant_id, type, display_name, credentials)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenantId, type, displayName, credentials]
  );
  return row!;
}

export async function listChannels(tenantId: string): Promise<Channel[]> {
  return query<Channel>(
    // credentials withheld from list responses — never send tokens/secrets to the frontend
    `SELECT id, tenant_id, type, display_name, status, created_at FROM channels
     WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
}

export async function setDefaultFlow(
  tenantId: string,
  channelId: string,
  flowId: string | null
): Promise<void> {
  await query("UPDATE channels SET default_flow_id = $1 WHERE id = $2 AND tenant_id = $3", [
    flowId,
    channelId,
    tenantId,
  ]);
}

export async function getChannelWithCredentials(
  tenantId: string,
  channelId: string
): Promise<Channel | null> {
  return queryOne<Channel>(
    "SELECT * FROM channels WHERE tenant_id = $1 AND id = $2",
    [tenantId, channelId]
  );
}

/** Same tenant-agnostic-caller exception as getCampaignByIdUnscoped — see that function's comment. */
export async function getChannelByIdUnscoped(channelId: string): Promise<Channel | null> {
  return queryOne<Channel>("SELECT * FROM channels WHERE id = $1", [channelId]);
}

export async function updateChannel(
  tenantId: string,
  channelId: string,
  updates: { displayName?: string; credentials?: Record<string, any>; status?: string }
): Promise<Channel | null> {
  // Credentials are replaced wholesale rather than merged: a partial update
  // (e.g. rotating just accessToken) should still send the full object the
  // caller wants stored, so a stale key from before can't linger silently.
  return queryOne<Channel>(
    `UPDATE channels SET
       display_name = COALESCE($1, display_name),
       credentials  = COALESCE($2, credentials),
       status       = COALESCE($3, status)
     WHERE id = $4 AND tenant_id = $5
     RETURNING *`,
    [updates.displayName ?? null, updates.credentials ?? null, updates.status ?? null, channelId, tenantId]
  );
}
