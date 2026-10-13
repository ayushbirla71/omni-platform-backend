import * as XLSX from "xlsx";
import { query } from "../../db/pool";
import { getFlow } from "../flows/flows.service";
import { getCampaign } from "./campaigns.service";

/** Hard cap so a single export cannot exhaust server memory (the workbook is built in memory). */
export const MAX_EXPORT_RECIPIENTS = 50_000;
const RECIPIENT_BATCH_SIZE = 1_000;
/** Excel rejects cells longer than 32,767 characters. */
const MAX_CELL_LENGTH = 32_000;

export interface CampaignExportColumn {
  nodeId: string;
  header: string;
}

export interface CampaignExportRow {
  name: string;
  phone: string;
  email: string;
  status: string;
  deliveredAt: string;
  readAt: string;
  failedAt: string;
  failureReason: string;
  answers: Map<string, string>;
  lastAnsweredAt: string;
}

export interface CampaignExportData {
  campaignName: string;
  columns: CampaignExportColumn[];
  rows: CampaignExportRow[];
}

interface RecipientExportRow {
  id: string;
  name: string | null;
  external_id: string | null;
  email: string | null;
  status: string;
  delivered_at: Date | string | null;
  read_at: Date | string | null;
  failed_at: Date | string | null;
  last_error: string | null;
  error_code: string | null;
}

interface AnswerExportRow {
  campaign_recipient_id: string;
  node_id: string;
  question: string;
  answer: string;
  answered_at: Date | string;
}

const toIso = (value: Date | string | null): string => (value ? new Date(value).toISOString() : "");

function exportError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Question columns come from the campaign's flow (so unanswered questions still get a column),
 * followed by answered questions whose node no longer exists in the flow.
 */
async function resolveQuestionColumns(
  tenantId: string,
  flowId: string | undefined,
  answers: AnswerExportRow[]
): Promise<CampaignExportColumn[]> {
  const columns: CampaignExportColumn[] = [];
  const knownNodeIds = new Set<string>();

  const flow = flowId ? await getFlow(tenantId, flowId) : null;
  for (const node of flow?.definition.nodes ?? []) {
    if (node.type === "input") {
      columns.push({ nodeId: node.id, header: node.prompt });
      knownNodeIds.add(node.id);
    } else if (node.type === "template" && (node.saveAs || node.buttons?.length)) {
      columns.push({ nodeId: node.id, header: `Template: ${node.templateName}` });
      knownNodeIds.add(node.id);
    }
  }

  for (const answer of answers) {
    if (knownNodeIds.has(answer.node_id)) continue;
    knownNodeIds.add(answer.node_id);
    columns.push({ nodeId: answer.node_id, header: answer.question });
  }

  // Two questions can share the same wording; keep every header unique.
  const seen = new Map<string, number>();
  return columns.map((column) => {
    const count = (seen.get(column.header) ?? 0) + 1;
    seen.set(column.header, count);
    return count === 1 ? column : { ...column, header: `${column.header} (${count})` };
  });
}

/**
 * Loads one row per campaign recipient plus the answers they gave inside the campaign's flow.
 * Returns null when the campaign does not exist for this tenant.
 */
export async function getCampaignExportData(
  tenantId: string,
  campaignId: string
): Promise<CampaignExportData | null> {
  const campaign = await getCampaign(tenantId, campaignId);
  if (!campaign) return null;

  if ((campaign.total_recipients ?? 0) > MAX_EXPORT_RECIPIENTS) {
    throw exportError(
      `This campaign has more than ${MAX_EXPORT_RECIPIENTS} recipients, which is too many to export at once.`,
      413
    );
  }

  const answerRows = await query<AnswerExportRow>(
    `SELECT campaign_recipient_id, node_id, question, answer, answered_at
     FROM campaign_answers
     WHERE tenant_id = $1 AND campaign_id = $2
     ORDER BY answered_at ASC`,
    [tenantId, campaignId]
  );

  const answersByRecipient = new Map<string, AnswerExportRow[]>();
  for (const answer of answerRows) {
    const list = answersByRecipient.get(answer.campaign_recipient_id) ?? [];
    list.push(answer);
    answersByRecipient.set(answer.campaign_recipient_id, list);
  }

  const flowId = (campaign.definition as { flowId?: unknown }).flowId;
  const columns = await resolveQuestionColumns(
    tenantId,
    typeof flowId === "string" ? flowId : undefined,
    answerRows
  );

  const rows: CampaignExportRow[] = [];
  let lastRecipientId: string | null = null;

  // Keyset pagination keeps each query small and stable while the campaign receives receipts.
  for (;;) {
    const batch: RecipientExportRow[] = await query<RecipientExportRow>(
      `SELECT cr.id, ct.name, ct.external_id, (ct.attributes->>'email') AS email,
              cr.status, cr.delivered_at, cr.read_at, cr.failed_at, cr.last_error, cr.error_code
       FROM campaign_recipients cr
       JOIN contacts ct ON ct.id = cr.contact_id AND ct.tenant_id = $1
       WHERE cr.campaign_id = $2 AND ($3::uuid IS NULL OR cr.id > $3::uuid)
       ORDER BY cr.id
       LIMIT $4`,
      [tenantId, campaignId, lastRecipientId, RECIPIENT_BATCH_SIZE]
    );
    if (batch.length === 0) break;

    for (const recipient of batch) {
      const recipientAnswers = answersByRecipient.get(recipient.id) ?? [];
      const answers = new Map(recipientAnswers.map((a) => [a.node_id, a.answer]));
      // Answers are loaded ordered by answered_at, so the last one is the most recent.
      const lastAnswered = recipientAnswers.at(-1)?.answered_at ?? null;

      rows.push({
        name: recipient.name ?? "",
        phone: recipient.external_id ?? "",
        email: recipient.email ?? "",
        status: recipient.status,
        deliveredAt: toIso(recipient.delivered_at),
        readAt: toIso(recipient.read_at),
        failedAt: toIso(recipient.failed_at),
        failureReason: recipient.last_error ?? recipient.error_code ?? "",
        answers,
        lastAnsweredAt: toIso(lastAnswered),
      });
    }

    lastRecipientId = batch[batch.length - 1].id;
    if (batch.length < RECIPIENT_BATCH_SIZE) break;
  }

  return { campaignName: campaign.name, columns, rows };
}

const clip = (value: string): string => (value.length > MAX_CELL_LENGTH ? value.slice(0, MAX_CELL_LENGTH) : value);

/**
 * Builds the .xlsx file. Every value is written as a string cell, which spreadsheet apps show as
 * text and never evaluate as a formula, so a reply such as "=1+1" is harmless.
 */
export function buildCampaignExportWorkbook(data: CampaignExportData): Buffer {
  const header = [
    "Name",
    "Phone",
    "Email",
    "Status",
    "Delivered at (UTC)",
    "Read at (UTC)",
    "Failed at (UTC)",
    "Failure reason",
    ...data.columns.map((column) => clip(column.header)),
    "Last answered at (UTC)",
  ];

  const body = data.rows.map((row) => [
    row.name,
    row.phone,
    row.email,
    row.status,
    row.deliveredAt,
    row.readAt,
    row.failedAt,
    row.failureReason,
    ...data.columns.map((column) => clip(row.answers.get(column.nodeId) ?? "")),
    row.lastAnsweredAt,
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([header, ...body]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Responses");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** ASCII-only file name safe for a Content-Disposition header. */
export function campaignExportFileName(campaignName: string): string {
  const slug = campaignName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `campaign-${slug || "export"}-responses.xlsx`;
}
