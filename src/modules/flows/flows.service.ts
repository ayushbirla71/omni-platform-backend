import { query, queryOne } from "../../db/pool";
import { FlowDefinition } from "./flows.types";

export interface Flow {
  id: string;
  tenant_id: string;
  name: string;
  definition: FlowDefinition;
  status: "draft" | "published";
  version: number;
  created_at: string;
  updated_at: string;
}

export interface FlowRun {
  id: string;
  conversation_id: string;
  flow_id: string;
  current_node_id: string | null;
  variables: Record<string, any>;
  status: "running" | "completed" | "handed_off";
  created_at: string;
  updated_at: string;
}

export async function createFlow(params: {
  tenantId: string;
  name: string;
  definition: FlowDefinition;
}): Promise<Flow> {
  const row = await queryOne<Flow>(
    `INSERT INTO flows (tenant_id, name, definition) VALUES ($1, $2, $3) RETURNING *`,
    [params.tenantId, params.name, params.definition]
  );
  return row!;
}

export async function updateFlowDefinition(
  tenantId: string,
  flowId: string,
  definition: FlowDefinition
): Promise<Flow | null> {
  // Only draft flows can be edited in place — a published flow may already
  // have active flow_runs mid-execution against it, so mutating it under
  // them would corrupt conversations in progress.
  return queryOne<Flow>(
    `UPDATE flows SET definition = $1, updated_at = now()
     WHERE id = $2 AND tenant_id = $3 AND status = 'draft' RETURNING *`,
    [definition, flowId, tenantId]
  );
}

export async function publishFlow(tenantId: string, flowId: string): Promise<Flow | null> {
  return queryOne<Flow>(
    `UPDATE flows SET status = 'published', version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [flowId, tenantId]
  );
}

export async function getFlow(tenantId: string, flowId: string): Promise<Flow | null> {
  return queryOne<Flow>("SELECT * FROM flows WHERE id = $1 AND tenant_id = $2", [flowId, tenantId]);
}

export async function listFlows(tenantId: string): Promise<Flow[]> {
  return query<Flow>("SELECT * FROM flows WHERE tenant_id = $1 ORDER BY updated_at DESC", [
    tenantId,
  ]);
}

export async function getActiveFlowRun(conversationId: string): Promise<FlowRun | null> {
  return queryOne<FlowRun>(
    `SELECT * FROM flow_runs WHERE conversation_id = $1 AND status = 'running'
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
}

export async function createFlowRun(params: {
  conversationId: string;
  flowId: string;
}): Promise<FlowRun> {
  const row = await queryOne<FlowRun>(
    `INSERT INTO flow_runs (conversation_id, flow_id) VALUES ($1, $2) RETURNING *`,
    [params.conversationId, params.flowId]
  );
  return row!;
}

export async function updateFlowRun(
  flowRunId: string,
  updates: { currentNodeId: string | null; variables: Record<string, any>; status: FlowRun["status"] }
): Promise<void> {
  await query(
    `UPDATE flow_runs SET current_node_id = $1, variables = $2, status = $3, updated_at = now()
     WHERE id = $4`,
    [updates.currentNodeId, updates.variables, updates.status, flowRunId]
  );
}
