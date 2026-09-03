import { query, queryOne } from "../../db/pool";

export interface Deal {
  id: string;
  tenant_id: string;
  contact_id: string;
  title: string;
  stage: string;
  value: string | null; // numeric comes back as string from pg — caller parses if needed
  created_at: string;
  updated_at: string;
}

export async function createDeal(params: {
  tenantId: string;
  contactId: string;
  title: string;
  stage?: string;
  value?: number;
}): Promise<Deal> {
  const row = await queryOne<Deal>(
    `INSERT INTO deals (tenant_id, contact_id, title, stage, value)
     VALUES ($1, $2, $3, COALESCE($4, 'new'), $5) RETURNING *`,
    [params.tenantId, params.contactId, params.title, params.stage ?? null, params.value ?? null]
  );
  return row!;
}

export async function listDeals(tenantId: string, stage?: string): Promise<Deal[]> {
  if (stage) {
    return query<Deal>(
      "SELECT * FROM deals WHERE tenant_id = $1 AND stage = $2 ORDER BY updated_at DESC",
      [tenantId, stage]
    );
  }
  return query<Deal>("SELECT * FROM deals WHERE tenant_id = $1 ORDER BY updated_at DESC", [
    tenantId,
  ]);
}

export async function updateDealStage(
  tenantId: string,
  dealId: string,
  stage: string
): Promise<Deal | null> {
  return queryOne<Deal>(
    "UPDATE deals SET stage = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 RETURNING *",
    [stage, dealId, tenantId]
  );
}

/** Simple pipeline summary: count + total value per stage. Powers a Kanban-style board. */
export async function getPipelineSummary(
  tenantId: string
): Promise<{ stage: string; count: number; totalValue: number }[]> {
  const rows = await query<{ stage: string; count: string; total_value: string | null }>(
    `SELECT stage, COUNT(*) as count, COALESCE(SUM(value), 0) as total_value
     FROM deals WHERE tenant_id = $1 GROUP BY stage`,
    [tenantId]
  );
  return rows.map((r) => ({
    stage: r.stage,
    count: Number(r.count),
    totalValue: Number(r.total_value),
  }));
}
