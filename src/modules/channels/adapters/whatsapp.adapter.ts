import crypto from "crypto";
import { ChannelAdapter, NormalizedMessage, OutboundMessage, MessageStatusUpdate } from "./channel-adapter.interface";

/**
 * WhatsApp adapter, written against the Meta Cloud API webhook shape (most
 * BSPs — Gupshup, 360dialog, etc. — either pass this shape through directly
 * or something very close to it). The `send()` method's endpoint/auth will
 * need a small tweak per BSP once one is chosen; the parsing/verification
 * logic below is provider-agnostic Meta Cloud API format.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = "whatsapp" as const;

  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    credentials: { appSecret?: string }
  ): boolean {
    const signatureHeader = headers["x-hub-signature-256"];
    if (!signatureHeader || typeof signatureHeader !== "string") return false;

    // Real Tech Provider case: Meta signs every webhook with YOUR platform's
    // single app secret, not a per-tenant one — one Meta app receives
    // webhooks for every onboarded WABA (see completeEmbeddedSignup, which
    // stores wabaId/phoneNumberId/accessToken but no appSecret). Falling
    // back to credentials.appSecret only matters for manually-created
    // channels (tests, or a future BSP path with its own signing secret).
    const secret = credentials.appSecret || process.env.META_APP_SECRET;
    if (!secret) {
      console.error(
        "verifyWebhookSignature: no appSecret on the channel and META_APP_SECRET is not set — rejecting"
      );
      return false;
    }

    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    // Constant-time compare to avoid timing attacks
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  parseWebhook(payload: any): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];

    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        const value = change?.value;
        const contacts = value?.contacts ?? [];
        const contactName = contacts[0]?.profile?.name;

        for (const msg of value?.messages ?? []) {
          messages.push({
            channelExternalContactId: msg.from,
            contactName,
            type: mapMessageType(msg.type),
            text: msg.text?.body ?? extractInteractiveReplyText(msg),
            mediaUrl: msg.image?.id || msg.document?.id || undefined, // media needs a follow-up media-download call
            raw: msg,
            receivedAt: new Date(Number(msg.timestamp) * 1000),
          });
        }
      }
    }

    return messages;
  }

  parseStatusWebhook(payload: any): MessageStatusUpdate[] {
    const statusUpdates: MessageStatusUpdate[] = [];

    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        const value = change?.value;

        // Status updates come in value.statuses array (separate from value.messages)
        for (const status of value?.statuses ?? []) {
          const errorInfo = status.errors?.[0];

          statusUpdates.push({
            providerMessageId: status.id,
            status: mapStatusValue(status.status),
            errorCode: errorInfo?.code ? String(errorInfo.code) : undefined,
            errorMessage: errorInfo?.message || errorInfo?.title || errorInfo?.error_data?.details || undefined,
            timestamp: new Date(Number(status.timestamp) * 1000),
          });
        }
      }
    }

    return statusUpdates;
  }

  async send(
    message: OutboundMessage,
    credentials: { phoneNumberId: string; accessToken: string; apiBaseUrl?: string }
  ): Promise<{ providerMessageId: string }> {
    const baseUrl = credentials.apiBaseUrl || "https://graph.facebook.com/v20.0";
    const url = `${baseUrl}/${credentials.phoneNumberId}/messages`;

    const body = buildOutboundBody(message);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      let errorMsg = `WhatsApp send failed (${response.status}): ${errText}`;
      try {
        const parsed = JSON.parse(errText);
        const metaErr = parsed?.error;
        if (metaErr) {
          if (metaErr.code === 131047) {
            errorMsg = "WhatsApp 24-hour customer window expired. You must use an approved template to re-engage with this customer.";
          } else if (metaErr.message) {
            errorMsg = `WhatsApp API error (${metaErr.code || response.status}): ${metaErr.message}`;
            if (metaErr.error_data?.details) {
              errorMsg += ` - ${metaErr.error_data.details}`;
            }
          }
        }
      } catch {}
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as { messages?: { id: string }[] };
    return { providerMessageId: data.messages?.[0]?.id ?? "" };
  }

  /**
   * WhatsApp media is a two-step fetch: NormalizedMessage.mediaUrl actually
   * holds a media ID (see parseWebhook above), not a real URL. Step 1 asks
   * Graph API for a temporary signed URL for that ID; step 2 downloads the
   * actual bytes from it (which itself still requires the bearer token —
   * Meta's temporary URLs aren't public).
   */
  async downloadMedia(
    mediaId: string,
    credentials: { accessToken: string; apiBaseUrl?: string }
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const baseUrl = credentials.apiBaseUrl || "https://graph.facebook.com/v20.0";

    const lookupResponse = await fetch(`${baseUrl}/${mediaId}`, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    if (!lookupResponse.ok) {
      throw new Error(`WhatsApp media lookup failed (${lookupResponse.status}): ${await lookupResponse.text()}`);
    }
    const lookup = (await lookupResponse.json()) as { url?: string; mime_type?: string };
    if (!lookup.url) throw new Error("WhatsApp media lookup response missing url");

    const fileResponse = await fetch(lookup.url, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    if (!fileResponse.ok) {
      throw new Error(`WhatsApp media download failed (${fileResponse.status})`);
    }
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    return { buffer, contentType: lookup.mime_type || "application/octet-stream" };
  }
}

function mapMessageType(waType: string): NormalizedMessage["type"] {
  switch (waType) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "document":
      return "document";
    case "audio":
      return "audio";
    case "button":
    case "interactive":
      return "button";
    default:
      return "unknown";
  }
}

function mapStatusValue(waStatus: string): MessageStatusUpdate["status"] {
  switch (waStatus) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return "failed";
    default:
      return "sent";
  }
}

/**
 * A tapped quick-reply button or list item arrives as msg.button.text or
 * msg.interactive.{button_reply,list_reply}.title, never as msg.text. The
 * flow engine's `input` nodes only look at NormalizedMessage.text, so
 * without this a button tap would silently fail to advance a waiting flow.
 */
function extractInteractiveReplyText(msg: any): string | undefined {
  if (msg.button?.text) return msg.button.text;
  const interactive = msg.interactive;
  return interactive?.button_reply?.title ?? interactive?.list_reply?.title;
}

function buildOutboundBody(message: OutboundMessage) {
  const base = {
    messaging_product: "whatsapp",
    to: message.toExternalContactId,
  };

  if (message.type === "text") {
    return { ...base, type: "text", text: { body: message.text } };
  }
  if (message.type === "template") {
    const components: any[] = [];

    // Header component
    if (message.headerType && message.headerValue) {
      if (message.headerType === "TEXT") {
        components.push({
          type: "header",
          parameters: [{ type: "text", text: message.headerValue }],
        });
      } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(message.headerType)) {
        components.push({
          type: "header",
          parameters: [
            {
              type: message.headerType.toLowerCase(),
              [message.headerType.toLowerCase()]: { link: message.headerValue },
            },
          ],
        });
      }
    }

    // Body parameters
    if (message.templateParams && Object.keys(message.templateParams).length > 0) {
      const paramKeys = Object.keys(message.templateParams).sort((a, b) => {
        const numA = Number(a);
        const numB = Number(b);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.localeCompare(b);
      });

      components.push({
        type: "body",
        parameters: paramKeys.map((k) => ({
          type: "text",
          text: message.templateParams![k],
        })),
      });
    }

    return {
      ...base,
      type: "template",
      template: {
        name: message.templateName,
        language: { code: message.templateLanguage || "en" },
        components,
      },
    };
  }
  // image / document
  return {
    ...base,
    type: message.type,
    [message.type]: { link: message.mediaUrl },
  };
}
