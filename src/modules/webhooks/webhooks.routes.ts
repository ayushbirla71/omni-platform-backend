import { Router } from "express";
import { queryOne } from "../../db/pool";
import { getAdapter } from "../channels/channel-registry";
import { findOrCreateContact } from "../contacts/contacts.service";
import { findOrCreateOpenConversation } from "../conversations/conversations.service";
import { recordInboundMessage, recordMessageStatusEvent } from "../messages/messages.service";
import { runFlowForConversation, handleDeliveryStatusCallback } from "../flows/flow-engine-runner";
import { asyncHandler } from "../../middleware/async-handler";
import { uploadMedia } from "../../db/object-storage";

export const webhooksRouter = Router();

interface ChannelRow {
  id: string;
  tenant_id: string;
  credentials: any;
  default_flow_id: string | null;
}

/**
 * Shared by every channel:
 * 1. Verifies cryptographic signature
 * 2. Parses delivery status receipts (sent/delivered/read/failed) & ecosystem errors
 * 3. Parses inbound messages & triggers flow engine passes
 */
async function processInboundWebhook(
  channelType: string,
  channelId: string,
  rawBody: string,
  parsedBody: any,
  headers: Record<string, string | string[] | undefined>
): Promise<{ status: number }> {
  const channel = await queryOne<ChannelRow>(
    "SELECT id, tenant_id, credentials, default_flow_id FROM channels WHERE id = $1 AND type = $2",
    [channelId, channelType]
  );
  if (!channel) return { status: 404 };

  const adapter = getAdapter(channelType);

  const signatureOk = adapter.verifyWebhookSignature(rawBody, headers, channel.credentials);
  if (!signatureOk) {
    console.warn(`Rejected ${channelType} webhook for channel ${channelId}: bad signature`);
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
          console.error(`[webhooks] delivery callback handler failed for ${update.providerMessageId}:`, err);
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
    if (msg.mediaUrl && (msg.type === "image" || msg.type === "document" || msg.type === "audio")) {
      try {
        const { buffer, contentType } = await adapter.downloadMedia(msg.mediaUrl, channel.credentials);
        const extension = contentType.split("/")[1] || "bin";
        const key = `${channel.tenant_id}/${conversation.id}/${Date.now()}.${extension}`;
        await uploadMedia({ key, body: buffer, contentType });
        storedMediaKey = key;
      } catch (err) {
        console.error(`[webhooks] media download/upload failed for channel ${channelId} (non-fatal):`, err);
      }
    }

    await recordInboundMessage({
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
    });

    if ((msg.type === "text" || msg.type === "button") && msg.text) {
      await runFlowForConversation({
        tenantId: channel.tenant_id,
        conversationId: conversation.id,
        defaultFlowId: channel.default_flow_id,
        incomingText: msg.text,
      });
    }
  }

  return { status: 200 };
}

webhooksRouter.get("/whatsapp/:channelId", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

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
