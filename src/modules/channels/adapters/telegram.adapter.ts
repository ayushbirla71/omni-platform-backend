import { ChannelAdapter, NormalizedMessage, OutboundMessage } from "./channel-adapter.interface";

/**
 * Telegram's Bot API webhook shape is entirely different from Meta's — no
 * `entry[].changes[]` nesting, no HMAC signature, a completely different
 * message envelope. That's exactly the case this adapter pattern exists
 * for: none of that difference should leak past this file.
 *
 * Telegram verifies webhooks via a secret token you choose when calling
 * setWebhook, echoed back on every request in the
 * `X-Telegram-Bot-Api-Secret-Token` header — a simple string compare, no
 * HMAC needed (unlike WhatsApp's `X-Hub-Signature-256`).
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;

  verifyWebhookSignature(
    _rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    credentials: { webhookSecretToken: string }
  ): boolean {
    const header = headers["x-telegram-bot-api-secret-token"];
    return typeof header === "string" && header === credentials.webhookSecretToken;
  }

  parseWebhook(payload: any): NormalizedMessage[] {
    const msg = payload?.message;
    if (!msg) return []; // could be an edited_message, callback_query, etc. — not handled yet

    const text = msg.text ?? msg.caption;
    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;

    return [
      {
        channelExternalContactId: String(msg.chat.id),
        contactName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || undefined,
        type: text ? "text" : hasPhoto ? "image" : msg.document ? "document" : "unknown",
        text,
        mediaUrl: hasPhoto ? msg.photo[msg.photo.length - 1].file_id : msg.document?.file_id,
        providerMessageId: String(msg.message_id),
        raw: msg,
        receivedAt: new Date(msg.date * 1000), // Telegram sends Unix seconds, same as WhatsApp
      },
    ];
  }

  async send(
    message: OutboundMessage,
    credentials: { botToken: string; apiBaseUrl?: string }
  ): Promise<{ providerMessageId: string }> {
    if (!credentials?.botToken) {
      throw new Error("Channel is missing botToken in credentials. Please reconnect the Telegram channel.");
    }

    const baseUrl = credentials.apiBaseUrl || "https://api.telegram.org";

    if (message.type === "template") {
      // Telegram has no template-approval concept — this only makes sense
      // for WhatsApp. Surfacing this loudly beats silently sending nothing.
      throw new Error("Telegram adapter does not support template messages");
    }

    let endpoint = "sendMessage";
    const body: Record<string, any> = { chat_id: message.toExternalContactId };

    if (message.type === "text") {
      endpoint = "sendMessage";
      body.text = message.text ?? "";
    } else if (message.type === "image") {
      endpoint = "sendPhoto";
      body.photo = message.mediaUrl;
      if (message.text) body.caption = message.text;
    } else if (message.type === "document") {
      endpoint = "sendDocument";
      body.document = message.mediaUrl;
      if (message.text) body.caption = message.text;
    } else if (message.type === "video") {
      endpoint = "sendVideo";
      body.video = message.mediaUrl;
      if (message.text) body.caption = message.text;
    } else if (message.type === "audio") {
      endpoint = "sendAudio";
      body.audio = message.mediaUrl;
      if (message.text) body.caption = message.text;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/bot${credentials.botToken}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (networkErr: any) {
      if (networkErr?.name === "AbortError") {
        throw new Error("Telegram API request timed out after 15 seconds.");
      }
      throw new Error(`Telegram network connection error: ${networkErr?.message || networkErr}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Telegram send failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { result?: { message_id: number } };
    return { providerMessageId: String(data.result?.message_id ?? "") };
  }

  /**
   * Telegram's inbound photo/document messages give a file_id (see
   * parseWebhook above), which needs a getFile lookup to resolve a
   * file_path before the actual bytes can be downloaded — different
   * mechanics from WhatsApp's media-ID-then-signed-URL flow, but the same
   * two-step shape.
   */
  async downloadMedia(
    fileId: string,
    credentials: { botToken: string; apiBaseUrl?: string }
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const baseUrl = credentials.apiBaseUrl || "https://api.telegram.org";

    const lookupResponse = await fetch(`${baseUrl}/bot${credentials.botToken}/getFile?file_id=${fileId}`);
    if (!lookupResponse.ok) {
      throw new Error(`Telegram getFile failed (${lookupResponse.status}): ${await lookupResponse.text()}`);
    }
    const lookup = (await lookupResponse.json()) as { result?: { file_path?: string } };
    const filePath = lookup.result?.file_path;
    if (!filePath) throw new Error("Telegram getFile response missing file_path");

    const fileResponse = await fetch(`${baseUrl}/file/bot${credentials.botToken}/${filePath}`);
    if (!fileResponse.ok) {
      throw new Error(`Telegram media download failed (${fileResponse.status})`);
    }
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    // Telegram's file download doesn't return a Content-Type header reliably —
    // infer a reasonable default from the file extension, falling back generically.
    const contentType = filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")
      ? "image/jpeg"
      : "application/octet-stream";
    return { buffer, contentType };
  }
}
