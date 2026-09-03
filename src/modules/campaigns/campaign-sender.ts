import { getAdapter } from "../channels/channel-registry";
import { getChannelWithCredentials, getChannelByIdUnscoped } from "../channels/channels.service";
import {
  getCampaign,
  getCampaignByIdUnscoped,
  setCampaignStatus,
  getRecipientsByStatus,
  getDueDripRecipients,
  markBroadcastSent,
  markRecipientFailed,
  advanceDripRecipient,
  completeDripRecipient,
} from "./campaigns.service";
import { BroadcastDefinition, DripDefinition, FlowCampaignDefinition, interpolate } from "./campaigns.types";
import { findOrCreateOpenConversation } from "../conversations/conversations.service";
import { runFlowForConversation } from "../flows/flow-engine-runner";
import { getFlow } from "../flows/flows.service";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SEND_DELAY_MS = 250;

/**
 * Sends a 'broadcast' or 'flow' campaign to every pending recipient, right now.
 * When a flow is configured, it instantiates the conversation and executes the
 * visual flow engine pass (templates, buttons, wait timers, retries) for each contact.
 */
export async function sendBroadcastNow(
  tenantId: string,
  campaignId: string
): Promise<{ sent: number; failed: number }> {
  const campaign = await getCampaign(tenantId, campaignId);
  if (!campaign) throw new Error("Campaign not found");
  if (campaign.type !== "broadcast" && campaign.type !== "flow") {
    throw new Error("Only broadcast and flow campaigns can be triggered via sendBroadcastNow");
  }

  const channel = await getChannelWithCredentials(tenantId, campaign.channel_id);
  if (!channel) throw new Error("Channel not found");

  const definition = campaign.definition as BroadcastDefinition & FlowCampaignDefinition;
  const flowId = campaign.type === "flow" ? definition.flowId : definition.flowId;

  if (flowId) {
    const flow = await getFlow(tenantId, flowId);
    if (!flow || flow.status !== "published") {
      throw new Error(`Flow ${flowId} is missing or not published. Please publish the flow before launching the campaign.`);
    }
  }

  await setCampaignStatus(campaignId, "sending");

  const recipients = await getRecipientsByStatus(campaignId, "pending");
  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    try {
      if (flowId) {
        // 1. Flow-driven campaign: instantiate or reopen conversation, then run flow engine
        const conversation = await findOrCreateOpenConversation({
          tenantId,
          contactId: recipient.contact_id,
          channelId: campaign.channel_id,
        });

        await runFlowForConversation({
          tenantId,
          conversationId: conversation.id,
          defaultFlowId: flowId,
        });

        await markBroadcastSent(recipient.id);
        sent++;
      } else {
        // 2. Standard text broadcast message
        const adapter = getAdapter(channel.type);
        const text = interpolate(definition.text || "", { name: recipient.name });
        await adapter.send(
          { toExternalContactId: recipient.external_id, type: "text", text },
          channel.credentials
        );
        await markBroadcastSent(recipient.id);
        sent++;
      }
    } catch (err) {
      console.error(`[campaign-sender] Failed sending to recipient ${recipient.id}:`, err);
      await markRecipientFailed(recipient.id, err instanceof Error ? err.message : String(err));
      failed++;
    }

    await sleep(SEND_DELAY_MS);
  }

  await setCampaignStatus(campaignId, "completed");
  return { sent, failed };
}

/**
 * Called on a timer to process drip sequences.
 */
export async function processDueDripSteps(): Promise<{ processed: number; failed: number }> {
  const due = await getDueDripRecipients();
  let processed = 0;
  let failed = 0;

  for (const recipient of due) {
    try {
      const campaign = await getCampaignByIdUnscoped(recipient.campaign_id);
      if (!campaign) {
        await markRecipientFailed(recipient.id, "Campaign no longer exists");
        failed++;
        continue;
      }

      const channel = await getChannelByIdUnscoped(campaign.channel_id);
      if (!channel) {
        await markRecipientFailed(recipient.id, "Channel no longer exists");
        failed++;
        continue;
      }

      const definition = campaign.definition as DripDefinition;
      const step = definition.steps[recipient.current_step];
      if (!step) {
        await completeDripRecipient(recipient.id);
        continue;
      }

      const adapter = getAdapter(channel.type);
      const text = interpolate(step.text, { name: recipient.name });
      await adapter.send(
        { toExternalContactId: recipient.external_id, type: "text", text },
        channel.credentials
      );

      const nextStepIndex = recipient.current_step + 1;
      const nextStep = definition.steps[nextStepIndex];
      if (!nextStep) {
        await completeDripRecipient(recipient.id);
      } else {
        const nextSendAt = new Date(Date.now() + nextStep.delayHours * 60 * 60 * 1000);
        await advanceDripRecipient(recipient.id, nextStepIndex, nextSendAt);
      }

      processed++;
    } catch (err) {
      await markRecipientFailed(recipient.id, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  return { processed, failed };
}
