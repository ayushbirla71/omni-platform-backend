import { v4 as uuidv4 } from "uuid";
import { ChannelAdapter, NormalizedMessage, OutboundMessage, MessageStatusUpdate } from "./channel-adapter.interface";

/**
 * Webchat Channel Adapter
 * Normalizes live chat widget messages from website visitors and outbound messages from agents.
 */
export class WebchatAdapter implements ChannelAdapter {
  readonly type = "webchat" as const;

  verifyWebhookSignature(
    _rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
    _credentials: Record<string, any>
  ): boolean {
    // Webchat uses JWT guest session tokens verified at the API/WebSocket layer
    return true;
  }

  parseWebhook(payload: any): NormalizedMessage[] {
    if (!payload) return [];
    const msg = payload.message || payload;
    if (!msg) return [];

    return [
      {
        channelExternalContactId: String(msg.visitorSessionId || msg.contactId || msg.externalId || "guest"),
        contactName: msg.contactName || msg.name || "Website Visitor",
        type: msg.type || (msg.mediaUrl ? (msg.type || "image") : "text"),
        text: msg.text,
        mediaUrl: msg.mediaUrl,
        providerMessageId: msg.providerMessageId || `wc_in_${uuidv4()}`,
        raw: msg,
        receivedAt: msg.receivedAt ? new Date(msg.receivedAt) : new Date(),
      },
    ];
  }

  parseStatusWebhook(payload: any): MessageStatusUpdate[] {
    if (!payload || !payload.providerMessageId) return [];
    return [
      {
        providerMessageId: String(payload.providerMessageId),
        status: payload.status || "delivered",
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage,
        timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      },
    ];
  }

  async send(
    _message: OutboundMessage,
    _credentials: Record<string, any>
  ): Promise<{ providerMessageId: string }> {
    // For Webchat, outbound delivery is direct via real-time WebSocket & database persistence
    const providerMessageId = `wc_out_${uuidv4()}`;
    return { providerMessageId };
  }

  async downloadMedia(
    mediaIdOrUrl: string,
    _credentials: Record<string, any>
  ): Promise<{ buffer: Buffer; contentType: string }> {
    if (mediaIdOrUrl.startsWith("http://") || mediaIdOrUrl.startsWith("https://")) {
      const res = await fetch(mediaIdOrUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch media from ${mediaIdOrUrl}: HTTP ${res.status}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      return { buffer: Buffer.from(arrayBuffer), contentType };
    }

    throw new Error(`Webchat media must be a valid URL, received: ${mediaIdOrUrl}`);
  }
}
