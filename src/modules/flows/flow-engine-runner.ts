import { withLock } from "../../db/redis";
import { sendOutboundMessage } from "../messages/messages.service";
import {
  getActiveFlowRun,
  createFlowRun,
  updateFlowRun,
  getFlow,
} from "./flows.service";
import { advanceFlow, resumeFlowOnDeliveryStatus } from "./flow-engine";
import { scheduleDelayedFlowResume } from "../jobs/queue.service";

/**
 * Called from the webhook handler after an inbound message is persisted,
 * or from a delayed queue worker waking up.
 */
export async function runFlowForConversation(params: {
  tenantId: string;
  conversationId: string;
  defaultFlowId: string | null;
  incomingText?: string;
  resumeAtNodeId?: string;
}): Promise<void> {
  const { tenantId, conversationId, defaultFlowId, incomingText, resumeAtNodeId } = params;

  const result = await withLock(`flow-lock:${conversationId}`, 10_000, async () => {
    let flowRun = await getActiveFlowRun(conversationId);

    if (!flowRun) {
      if (!defaultFlowId) return; // no flow configured for this channel
      flowRun = await createFlowRun({ conversationId, flowId: defaultFlowId });
    }

    const flow = await getFlow(tenantId, flowRun.flow_id);
    if (!flow || flow.status !== "published") {
      console.warn(`[flow-engine] flow ${flowRun.flow_id} is missing or not published — skipping`);
      return;
    }

    const advance = advanceFlow(
      flow.definition,
      { currentNodeId: flowRun.current_node_id, variables: flowRun.variables },
      incomingText,
      resumeAtNodeId
    );

    // Send messages and record providerMessageId
    let lastProviderMessageId: string | undefined;

    for (const msg of advance.outboundMessages) {
      if (msg.type === "text") {
        const sent = await sendOutboundMessage({ tenantId, conversationId, text: msg.text });
        lastProviderMessageId = sent.provider_message_id;
      } else if (msg.type === "template") {
        const sent = await sendOutboundMessage({
          tenantId,
          conversationId,
          type: "template",
          templateName: msg.templateName,
          templateLanguage: msg.templateLanguage,
          templateParams: msg.templateParams,
        });
        lastProviderMessageId = sent.provider_message_id;
      }
    }

    const updatedVariables = { ...advance.variables };
    if (lastProviderMessageId) {
      updatedVariables["_last_wamid"] = lastProviderMessageId;
    }

    // Schedule delayed job if wait/retry node was hit
    if (advance.scheduledResume) {
      await scheduleDelayedFlowResume(
        {
          tenantId,
          conversationId,
          flowRunId: flowRun.id,
          targetNodeId: advance.scheduledResume.targetNodeId,
        },
        advance.scheduledResume.delaySeconds
      );
    }

    await updateFlowRun(flowRun.id, {
      currentNodeId: advance.nextNodeId,
      variables: updatedVariables,
      status: advance.status === "awaiting_delivery" || advance.status === "waiting" ? "running" : advance.status,
    });
  });

  if (result === "locked") {
    console.warn(`[flow-engine] conversation ${conversationId} is already being processed — skipped this pass`);
  }
}

/**
 * Called when a delivery receipt or failure status webhook arrives from WhatsApp.
 */
export async function handleDeliveryStatusCallback(params: {
  tenantId: string;
  conversationId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  const { tenantId, conversationId, status, errorCode, errorMessage } = params;

  if (status !== "delivered" && status !== "read" && status !== "failed") {
    return; // 'sent' status is an ack, does not advance delivery-wait nodes
  }

  const result = await withLock(`flow-lock:${conversationId}`, 10_000, async () => {
    const flowRun = await getActiveFlowRun(conversationId);
    if (!flowRun || !flowRun.current_node_id) return;

    const flow = await getFlow(tenantId, flowRun.flow_id);
    if (!flow || flow.status !== "published") return;

    const normalizedStatus = status === "read" ? "delivered" : status;

    const advance = resumeFlowOnDeliveryStatus(
      flow.definition,
      { currentNodeId: flowRun.current_node_id, variables: flowRun.variables },
      normalizedStatus,
      { code: errorCode, message: errorMessage }
    );

    // Send any subsequent messages along the chosen path
    for (const msg of advance.outboundMessages) {
      if (msg.type === "text") {
        await sendOutboundMessage({ tenantId, conversationId, text: msg.text });
      } else if (msg.type === "template") {
        await sendOutboundMessage({
          tenantId,
          conversationId,
          type: "template",
          templateName: msg.templateName,
          templateLanguage: msg.templateLanguage,
          templateParams: msg.templateParams,
        });
      }
    }

    if (advance.scheduledResume) {
      await scheduleDelayedFlowResume(
        {
          tenantId,
          conversationId,
          flowRunId: flowRun.id,
          targetNodeId: advance.scheduledResume.targetNodeId,
        },
        advance.scheduledResume.delaySeconds
      );
    }

    await updateFlowRun(flowRun.id, {
      currentNodeId: advance.nextNodeId,
      variables: advance.variables,
      status: advance.status === "awaiting_delivery" || advance.status === "waiting" ? "running" : advance.status,
    });
  });

  if (result === "locked") {
    console.warn(`[flow-engine] conversation ${conversationId} is locked during status update`);
  }
}
