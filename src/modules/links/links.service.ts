import QRCode from "qrcode";
import { Channel, updateChannel } from "../channels/channels.service";

export class UnsupportedChannelError extends Error {}

/**
 * Builds the platform-native "open a chat" link for a channel. Only
 * WhatsApp and Telegram have a public deep-link scheme that works without
 * the recipient already being in a conversation — Instagram/Facebook direct
 * messages don't have an equivalent public link format, so those channels
 * are deliberately unsupported here (see IMPLEMENTATION_TRACKER.md).
 */
export async function buildDeepLink(
  channel: Pick<Channel, "id" | "tenant_id" | "type" | "credentials" | "display_name">,
  prefilledText?: string
): Promise<string> {
  let credentials = channel.credentials;
  if (typeof credentials === "string") {
    try {
      credentials = JSON.parse(credentials);
    } catch {
      credentials = {};
    }
  }

  switch (channel.type) {
    case "whatsapp": {
      let rawPhone =
        credentials?.businessPhoneNumber ||
        credentials?.displayPhoneNumber ||
        credentials?.display_phone_number ||
        credentials?.phone ||
        credentials?.phoneNumber;

      // If missing from credentials but we have phoneNumberId and accessToken, fetch from Meta Graph API
      if (!rawPhone && credentials?.phoneNumberId && credentials?.accessToken) {
        try {
          const apiBaseUrl = credentials.apiBaseUrl || "https://graph.facebook.com/v21.0";
          console.log(`[Links] Resolving phone number details from Meta for Phone ID: ${credentials.phoneNumberId}...`);
          const res = await fetch(
            `${apiBaseUrl}/${credentials.phoneNumberId}?fields=display_phone_number,verified_name`,
            {
              headers: { Authorization: `Bearer ${credentials.accessToken}` },
            }
          );
          if (res.ok) {
            const data: any = await res.json();
            if (data?.display_phone_number) {
              rawPhone = data.display_phone_number;
              // Cache phone number in credentials if channel info is available
              if (channel.tenant_id && channel.id) {
                const updatedCredentials = {
                  ...credentials,
                  displayPhoneNumber: data.display_phone_number,
                  businessPhoneNumber: data.display_phone_number.replace(/\D/g, ""),
                  verifiedName: data.verified_name || credentials.verifiedName,
                };
                updateChannel(channel.tenant_id, channel.id, {
                  credentials: updatedCredentials,
                }).catch((err) => console.warn("[Links] Failed to cache phone number in channel credentials:", err));
              }
            }
          } else {
            console.warn(`[Links] Meta Graph API returned ${res.status} when fetching phone number for deep link`);
          }
        } catch (err) {
          console.warn("[Links] Error resolving phone number from Meta Graph API:", err);
        }
      }

      // Fallback: Check if display_name contains digits in parentheses e.g. "My Business (+1 555-123-4567)"
      if (!rawPhone && channel.display_name) {
        const match = channel.display_name.match(/\(([\+\d\s-]+)\)/);
        if (match && match[1]) {
          rawPhone = match[1];
        }
      }

      if (!rawPhone) {
        throw new Error(
          "WhatsApp channel is missing phone number. Please reconnect via Embedded Signup or verify channel credentials."
        );
      }

      const cleanPhone = String(rawPhone).replace(/\D/g, "");
      if (!cleanPhone) {
        throw new Error("Invalid WhatsApp phone number in channel credentials.");
      }

      const text = prefilledText ? `?text=${encodeURIComponent(prefilledText)}` : "";
      return `https://wa.me/${cleanPhone}${text}`;
    }
    case "telegram": {
      let username = credentials?.botUsername || credentials?.username || credentials?.bot_username;
      if (!username) {
        throw new Error("Telegram channel is missing bot username in credentials");
      }
      username = String(username).replace(/^@/, "");
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
