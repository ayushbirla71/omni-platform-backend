import { Router } from "express";
import { queryOne } from "../../db/pool";
import { getAdapter } from "../channels/channel-registry";
import { findOrCreateContact } from "../contacts/contacts.service";
import { findOrCreateOpenConversation } from "../conversations/conversations.service";
import { recordInboundMessage, recordMessageStatusEvent } from "../messages/messages.service";
import { runFlowForConversation, handleDeliveryStatusCallback } from "../flows/flow-engine-runner";
import { asyncHandler } from "../../middleware/async-handler";
import { uploadMedia } from "../../db/object-storage";
import { Logger } from "../../utils/logger";

const log = new Logger("webhooks");

export const webhooksRouter = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_REGEX.test(id);
}

function getExtensionFromMimeType(mimeType: string, defaultExt: string = "bin"): string {
  if (!mimeType) return defaultExt;
  // Strip parameters like codecs, e.g. "audio/ogg; codecs=opus" -> "audio/ogg"
  const cleanMime = mimeType.split(";")[0].trim().toLowerCase();
  switch (cleanMime) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "application/pdf":
      return "pdf";
    case "audio/ogg":
    case "audio/opus":
      return "ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/aac":
      return "aac";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "video/mp4":
      return "mp4";
    case "video/3gpp":
      return "3gp";
    case "application/msword":
      return "doc";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    case "application/vnd.ms-excel":
      return "xls";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "xlsx";
    default: {
      const sub = cleanMime.split("/")[1];
      return sub ? sub.replace(/[^a-z0-9]/gi, "") : defaultExt;
    }
  }
}

interface ChannelRow {
  id: string;
  tenant_id: string;
  credentials: any;
  default_flow_id: string | null;
}

/**
 * Shared by every channel:
 * 1. Resolves channel (by UUID if provided, or dynamically by Phone Number ID / WABA ID from payload)
 * 2. Verifies cryptographic signature
 * 3. Parses delivery status receipts (sent/delivered/read/failed) & ecosystem errors
 * 4. Parses inbound messages & triggers flow engine passes
 */
async function processInboundWebhook(
  channelType: string,
  channelId: string | undefined,
  rawBody: string,
  parsedBody: any,
  headers: Record<string, string | string[] | undefined>
): Promise<{ status: number }> {
  let channel: ChannelRow | null = null;

  // 1. If a valid UUID channelId is provided in URL, look up channel directly
  if (isValidUuid(channelId)) {
    channel = await queryOne<ChannelRow>(
      "SELECT id, tenant_id, credentials, default_flow_id FROM channels WHERE id = $1 AND type = $2",
      [channelId, channelType]
    );
  }

  // 2. If channel was not resolved by UUID (e.g. Meta app-level webhook to /webhooks/whatsapp or /webhooks/whatsapp/CHANNEL_ID),
  // dynamically resolve channel by WhatsApp Phone Number ID or WABA ID from payload
  if (!channel && channelType === "whatsapp" && parsedBody) {
    let extractedPhoneId: string | undefined;
    let extractedWabaId: string | undefined;

    for (const entry of parsedBody?.entry ?? []) {
      if (entry?.id) extractedWabaId = String(entry.id);
      for (const change of entry?.changes ?? []) {
        const pId = change?.value?.metadata?.phone_number_id;
        if (pId) extractedPhoneId = String(pId);
      }
    }

    if (extractedPhoneId) {
      channel = await queryOne<ChannelRow>(
        `SELECT id, tenant_id, credentials, default_flow_id
         FROM channels
         WHERE type = 'whatsapp'
           AND credentials->>'phoneNumberId' = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [extractedPhoneId]
      );
    }

    if (!channel && extractedWabaId) {
      channel = await queryOne<ChannelRow>(
        `SELECT id, tenant_id, credentials, default_flow_id
         FROM channels
         WHERE type = 'whatsapp'
           AND credentials->>'wabaId' = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [extractedWabaId]
      );
    }
  }

  if (!channel) {
    log.warn(
      `No matching channel found for ${channelType} webhook (channelId: "${channelId || ""}", entryId: "${parsedBody?.entry?.[0]?.id || ""}"). Responding 200 to prevent provider retry storms.`
    );
    return { status: 200 };
  }

  const adapter = getAdapter(channelType);

  const signatureOk = adapter.verifyWebhookSignature(rawBody, headers, channel.credentials);
  if (!signatureOk) {
    log.warn(`Rejected ${channelType} webhook for channel ${channel.id}: bad signature`);
    return { status: 401 };
  }

  // 1. Process delivery receipts and ecosystem status callbacks
  if (typeof adapter.parseStatusWebhook === "function") {
    const statusUpdates = adapter.parseStatusWebhook(parsedBody);
    for (const update of statusUpdates) {
      const { conversationId } = await recordMessageStatusEvent({
        tenantId: channel.tenant_id,
        providerMessageId: update.providerMessageId,
        status: update.status,
        errorCode: update.errorCode,
        errorMessage: update.errorMessage,
        timestamp: update.timestamp,
      });

      if (conversationId) {
        // Trigger state machine transition along Delivered or Failed port
        await handleDeliveryStatusCallback({
          tenantId: channel.tenant_id,
          conversationId,
          providerMessageId: update.providerMessageId,
          status: update.status,
          errorCode: update.errorCode,
          errorMessage: update.errorMessage,
        }).catch((err) => {
          log.error(`delivery callback handler failed for ${update.providerMessageId}:`, err);
        });
      }
    }
  }

  // 2. Process inbound customer messages
  const normalizedMessages = adapter.parseWebhook(parsedBody);

  for (const msg of normalizedMessages) {
    const contact = await findOrCreateContact({
      tenantId: channel.tenant_id,
      channelId: channel.id,
      externalId: msg.channelExternalContactId,
      name: msg.contactName,
    });

    const conversation = await findOrCreateOpenConversation({
      tenantId: channel.tenant_id,
      contactId: contact.id,
      channelId: channel.id,
    });

    let storedMediaKey: string | undefined;
    if (
      msg.mediaUrl &&
      (msg.type === "image" ||
        msg.type === "document" ||
        msg.type === "audio" ||
        msg.type === "video" ||
        msg.type === "sticker")
    ) {
      try {
        const { buffer, contentType } = await adapter.downloadMedia(msg.mediaUrl, channel.credentials);
        const extension = getExtensionFromMimeType(contentType, msg.type === "image" ? "jpg" : "bin");
        const key = `${channel.tenant_id}/${conversation.id}/${Date.now()}.${extension}`;
        await uploadMedia({ key, body: buffer, contentType });
        storedMediaKey = key;
        log.info(
          `Inbound media saved to storage: key=${key}, contentType=${contentType}, size=${buffer.length} bytes, type=${msg.type}`
        );
      } catch (err) {
        log.error(`media download/upload failed for channel ${channel.id} (non-fatal):`, err);
      }
    }

    const { isDuplicate } = await recordInboundMessage({
      tenantId: channel.tenant_id,
      conversationId: conversation.id,
      type: msg.type,
      content: {
        text: msg.text,
        mediaProviderId: msg.mediaUrl,
        mediaStorageKey: storedMediaKey,
        raw: msg.raw,
      },
      sentAt: msg.receivedAt,
      providerMessageId: msg.providerMessageId || (msg.raw as any)?.id,
    });

    if (isDuplicate) {
      log.info(`[webhooks] Deduplicated incoming message (${msg.providerMessageId || (msg.raw as any)?.id}) — skipping flow trigger`);
      continue;
    }

    if ((msg.type === "text" || msg.type === "button") && msg.text) {
      // Run flow asynchronously so webhook returns 200 OK immediately and prevents provider retry storms
      runFlowForConversation({
        tenantId: channel.tenant_id,
        conversationId: conversation.id,
        defaultFlowId: channel.default_flow_id,
        incomingText: msg.text,
      }).catch((err) => {
        log.error(`[webhooks] Flow execution failed for conversation ${conversation.id}:`, err);
      });
    }
  }

  return { status: 200 };
}

/**
 * WhatsApp Hub Verification handler (for Meta webhook challenge verification).
 * Works for both /webhooks/whatsapp and /webhooks/whatsapp/:channelId
 */
function handleWhatsAppVerification(req: any, res: any) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token && verifyToken && token === verifyToken) {
    log.info("WhatsApp webhook verified successfully");
    return res.status(200).send(challenge);
  }

  log.warn("WhatsApp webhook verification rejected (token mismatch or invalid mode)", {
    mode,
    hasToken: Boolean(token),
  });
  return res.sendStatus(403);
}

// Meta Webhook Verification (GET)
webhooksRouter.get("/whatsapp", handleWhatsAppVerification);
webhooksRouter.get("/whatsapp/:channelId", handleWhatsAppVerification);

// Meta WhatsApp Webhook Inbound (POST)
webhooksRouter.post(
  "/whatsapp",
  asyncHandler(async (req, res) => {
    const rawBody = ((req as any).rawBody as Buffer | undefined)?.toString("utf8") ?? JSON.stringify(req.body);
    const { status } = await processInboundWebhook(
      "whatsapp",
      undefined,
      rawBody,
      req.body,
      req.headers as any
    );
    res.sendStatus(status);
  })
);

webhooksRouter.post(
  "/whatsapp/:channelId",
  asyncHandler(async (req, res) => {
    const rawBody = ((req as any).rawBody as Buffer | undefined)?.toString("utf8") ?? JSON.stringify(req.body);
    const { status } = await processInboundWebhook(
      "whatsapp",
      req.params.channelId,
      rawBody,
      req.body,
      req.headers as any
    );
    res.sendStatus(status);
  })
);

// Telegram Webhook Inbound (POST)
webhooksRouter.post(
  "/telegram",
  asyncHandler(async (req, res) => {
    const rawBody = ((req as any).rawBody as Buffer | undefined)?.toString("utf8") ?? JSON.stringify(req.body);
    const { status } = await processInboundWebhook(
      "telegram",
      undefined,
      rawBody,
      req.body,
      req.headers as any
    );
    res.sendStatus(status);
  })
);

webhooksRouter.post(
  "/telegram/:channelId",
  asyncHandler(async (req, res) => {
    const rawBody = ((req as any).rawBody as Buffer | undefined)?.toString("utf8") ?? JSON.stringify(req.body);
    const { status } = await processInboundWebhook(
      "telegram",
      req.params.channelId,
      rawBody,
      req.body,
      req.headers as any
    );
    res.sendStatus(status);
  })
);
