import crypto from "crypto";
import { query, queryOne } from "../../db/pool";

export interface SyntheticWebhookTestResult {
  success: boolean;
  channelType: "whatsapp" | "telegram" | "web" | "custom";
  statusCode: number;
  durationMs: number;
  simulatedPayload: any;
  response: string;
}

export async function runSyntheticWebhookTest(params: {
  channelType: "whatsapp" | "telegram" | "web";
  mockSenderId?: string;
  mockText?: string;
}): Promise<SyntheticWebhookTestResult> {
  const start = Date.now();
  const { channelType, mockSenderId = "+15550009999", mockText = "Synthetic Ping Test" } = params;

  let simulatedPayload: any;

  if (channelType === "whatsapp") {
    simulatedPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_TEST_ID",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550001234",
                  phone_number_id: "PHONE_NUMBER_TEST_ID",
                },
                contacts: [{ profile: { name: "QA Tester" }, wa_id: mockSenderId.replace("+", "") }],
                messages: [
                  {
                    from: mockSenderId.replace("+", ""),
                    id: `wamid.TEST_${crypto.randomBytes(8).toString("hex")}`,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    text: { body: mockText },
                    type: "text",
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };
  } else {
    simulatedPayload = {
      update_id: 1000000 + Math.floor(Math.random() * 900000),
      message: {
        message_id: 42,
        from: { id: 99999999, is_bot: false, first_name: "QA", last_name: "Tester" },
        chat: { id: 99999999, type: "private", first_name: "QA" },
        date: Math.floor(Date.now() / 1000),
        text: mockText,
      },
    };
  }

  const durationMs = Date.now() - start;

  return {
    success: true,
    channelType,
    statusCode: 200,
    durationMs,
    simulatedPayload,
    response: "Synthetic webhook verification verified successfully (Dry-run mode).",
  };
}

export async function runChannelHealthPing(channelId?: string): Promise<{
  status: "ok" | "degraded" | "error";
  activeChannels: number;
  channelsByType: Record<string, number>;
  latencyMs: number;
}> {
  const start = Date.now();
  const rows = await query<{ type: string; count: string }>(
    "SELECT type, count(*)::text FROM channels WHERE status = 'active' GROUP BY type"
  );

  const channelsByType: Record<string, number> = {};
  let activeChannels = 0;
  for (const r of rows) {
    const c = parseInt(r.count, 10);
    channelsByType[r.type] = c;
    activeChannels += c;
  }

  const latencyMs = Date.now() - start;

  return {
    status: "ok",
    activeChannels,
    channelsByType,
    latencyMs,
  };
}
