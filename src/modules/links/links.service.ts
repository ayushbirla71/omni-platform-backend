import QRCode from "qrcode";
import { Channel } from "../channels/channels.service";

export class UnsupportedChannelError extends Error {}

/**
 * Builds the platform-native "open a chat" link for a channel. Only
 * WhatsApp and Telegram have a public deep-link scheme that works without
 * the recipient already being in a conversation — Instagram/Facebook direct
 * messages don't have an equivalent public link format, so those channels
 * are deliberately unsupported here (see IMPLEMENTATION_TRACKER.md).
 */
export function buildDeepLink(channel: Pick<Channel, "type" | "credentials">, prefilledText?: string): string {
  switch (channel.type) {
    case "whatsapp": {
      const phone = channel.credentials?.businessPhoneNumber;
      if (!phone) throw new Error("Channel is missing credentials.businessPhoneNumber");
      const text = prefilledText ? `?text=${encodeURIComponent(prefilledText)}` : "";
      return `https://wa.me/${phone}${text}`;
    }
    case "telegram": {
      const username = channel.credentials?.botUsername;
      if (!username) throw new Error("Channel is missing credentials.botUsername");
      const start = prefilledText ? `?start=${encodeURIComponent(prefilledText)}` : "";
      return `https://t.me/${username}${start}`;
    }
    default:
      throw new UnsupportedChannelError(
        `No public deep-link scheme for channel type "${channel.type}"`
      );
  }
}

/** Returns a data: URL (PNG) ready to drop straight into an <img src>. */
export async function generateQrCodeDataUrl(link: string): Promise<string> {
  return QRCode.toDataURL(link, { errorCorrectionLevel: "M", margin: 2 });
}
