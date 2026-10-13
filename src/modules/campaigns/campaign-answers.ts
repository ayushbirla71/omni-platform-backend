import { query } from "../../db/pool";

export interface CampaignAnswerInput {
  nodeId: string;
  question: string;
  answer: string;
}

/**
 * Stores the questions a campaign recipient answered inside the campaign's flow.
 * One row per (flow run, node): answering the same question again keeps the latest answer.
 */
export async function recordCampaignAnswers(params: {
  tenantId: string;
  campaignId: string;
  campaignRecipientId: string;
  flowRunId: string;
  answers: CampaignAnswerInput[];
}): Promise<void> {
  const { tenantId, campaignId, campaignRecipientId, flowRunId, answers } = params;

  for (const item of answers) {
    await query(
      `INSERT INTO campaign_answers
         (tenant_id, campaign_id, campaign_recipient_id, flow_run_id, node_id, question, answer)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (flow_run_id, node_id)
       DO UPDATE SET question = EXCLUDED.question,
                     answer = EXCLUDED.answer,
                     answered_at = now()`,
      [tenantId, campaignId, campaignRecipientId, flowRunId, item.nodeId, item.question, item.answer]
    );
  }
}
