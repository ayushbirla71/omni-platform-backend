import { FlowDefinition, FlowNode, WaitNode } from "./flows.types";

export interface OutboundFlowMessage {
  type: "text" | "template";
  text?: string;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: Record<string, string>;
  nodeId?: string;
  waitForDelivery?: boolean;
}

export interface ScheduledResume {
  delaySeconds: number;
  targetNodeId: string;
}

export interface AdvanceResult {
  nextNodeId: string | null;
  variables: Record<string, any>;
  status: "running" | "waiting" | "awaiting_delivery" | "completed" | "handed_off";
  /** Messages to send out, in order, as this pass through the graph executes. */
  outboundMessages: OutboundFlowMessage[];
  scheduledResume?: ScheduledResume;
}

function getNode(def: FlowDefinition, id: string): FlowNode | undefined {
  return def.nodes.find((n) => n.id === id);
}

function interpolate(template: string, vars: Record<string, any>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ""
  );
}

function convertDurationToSeconds(duration: number, unit?: string): number {
  switch (unit) {
    case "minutes":
      return duration * 60;
    case "hours":
      return duration * 3600;
    case "days":
      return duration * 86400;
    case "seconds":
    default:
      return duration;
  }
}

/**
 * Resolves the next node pointer from ports, status hooks, or default next.
 */
function resolvePortNext(node: FlowNode, portId: "continue" | "delivered" | "failed" | string): string | null {
  if (portId === "delivered" && (node as any).onDelivered) {
    return (node as any).onDelivered;
  }
  if (portId === "failed" && (node as any).onFailed) {
    return (node as any).onFailed;
  }
  const foundPort = (node as any).ports?.find((p: any) => p.id === portId);
  if (foundPort?.next) {
    return foundPort.next;
  }
  return (node as any).next ?? null;
}

/**
 * Pure state machine engine. Advances execution until an async pause
 * (input node, delivery confirmation wait, wait timer, or completion).
 */
export function advanceFlow(
  def: FlowDefinition,
  state: { currentNodeId: string | null; variables: Record<string, any> },
  incomingText?: string,
  resumeAtNodeId?: string
): AdvanceResult {
  let nodeId: string | null = resumeAtNodeId ?? state.currentNodeId ?? def.entryNodeId;
  const variables = { ...state.variables };
  const outboundMessages: OutboundFlowMessage[] = [];
  let pendingReply = incomingText;

  for (let steps = 0; steps < 100; steps++) {
    if (!nodeId) return { nextNodeId: null, variables, status: "completed", outboundMessages };

    const node = getNode(def, nodeId);
    if (!node) return { nextNodeId: null, variables, status: "completed", outboundMessages };

    switch (node.type) {
      case "message": {
        const interpolatedText = interpolate(node.text, variables);
        const shouldWaitForDelivery = Boolean(
          node.waitForDelivery || node.onDelivered || node.onFailed ||
          node.ports?.some((p) => p.id === "delivered" || p.id === "failed")
        );

        outboundMessages.push({
          type: "text",
          text: interpolatedText,
          nodeId: node.id,
          waitForDelivery: shouldWaitForDelivery,
        });

        if (shouldWaitForDelivery) {
          // Pause execution on this message node, waiting for WhatsApp status webhook callback
          return {
            nextNodeId: node.id,
            variables,
            status: "awaiting_delivery",
            outboundMessages,
          };
        }

        nodeId = resolvePortNext(node, "continue");
        continue;
      }

      case "input": {
        const alreadyWaitingHere = state.currentNodeId === node.id;
        if (alreadyWaitingHere && pendingReply !== undefined) {
          variables[node.saveAs] = pendingReply;
          pendingReply = undefined;
          nodeId = resolvePortNext(node, "continue");
          continue;
        }
        // First time reaching this node this pass — ask, then pause here.
        const interpolatedPrompt = interpolate(node.prompt, variables);
        outboundMessages.push({ type: "text", text: interpolatedPrompt, nodeId: node.id });
        return { nextNodeId: node.id, variables, status: "running", outboundMessages };
      }

      case "template": {
        const alreadyWaitingHere = state.currentNodeId === node.id;
        if (alreadyWaitingHere && pendingReply !== undefined) {
          if (node.saveAs) {
            variables[node.saveAs] = pendingReply;
          }

          // Match incoming reply against configured button actions (case-insensitive trim)
          const replyClean = pendingReply.trim().toLowerCase();
          const matchedButton = node.buttons?.find(
            (btn) => btn.buttonText.trim().toLowerCase() === replyClean
          );

          if (matchedButton) {
            nodeId = matchedButton.next;
          } else {
            nodeId = resolvePortNext(node, "continue");
          }

          pendingReply = undefined;
          continue;
        }

        // First time reaching this template node:
        const interpolatedParams: Record<string, string> = {};
        if (node.templateParams) {
          for (const [key, val] of Object.entries(node.templateParams)) {
            interpolatedParams[key] = interpolate(val, variables);
          }
        }

        const shouldWaitForDelivery = Boolean(
          node.waitForDelivery || node.onDelivered || node.onFailed ||
          node.ports?.some((p) => p.id === "delivered" || p.id === "failed")
        );

        outboundMessages.push({
          type: "template",
          templateName: node.templateName,
          templateLanguage: node.language || "en",
          templateParams: interpolatedParams,
          nodeId: node.id,
          waitForDelivery: shouldWaitForDelivery,
        });

        // If template has buttons, pause and wait for the user's interactive tap
        if (node.buttons && node.buttons.length > 0) {
          return { nextNodeId: node.id, variables, status: "running", outboundMessages };
        }

        if (shouldWaitForDelivery) {
          return {
            nextNodeId: node.id,
            variables,
            status: "awaiting_delivery",
            outboundMessages,
          };
        }

        // If no buttons and not waiting on delivery receipt, progress immediately
        nodeId = resolvePortNext(node, "continue");
        continue;
      }

      case "wait": {
        const durationSec = convertDurationToSeconds(node.duration, node.durationUnit);
        const targetNext = node.next || node.ports?.find((p) => p.id === "continue")?.next;

        if (!targetNext) {
          return { nextNodeId: null, variables, status: "completed", outboundMessages };
        }

        return {
          nextNodeId: node.id,
          variables,
          status: "waiting",
          outboundMessages,
          scheduledResume: {
            delaySeconds: durationSec,
            targetNodeId: targetNext,
          },
        };
      }

      case "condition": {
        const value = variables[node.variable];
        const branch = node.branches.find((b) => b.equals === String(value));
        nodeId = branch?.next ?? node.default ?? null;
        continue;
      }

      case "action": {
        console.log(`[flow-engine] webhook action dispatched: ${node.url}`);
        nodeId = (node as any).onSuccess || resolvePortNext(node, "continue");
        continue;
      }

      case "handoff": {
        return { nextNodeId: null, variables, status: "handed_off", outboundMessages };
      }

      case "end": {
        return { nextNodeId: null, variables, status: "completed", outboundMessages };
      }
    }
  }

  console.warn("[flow-engine] step limit reached — possible cycle in flow definition");
  return { nextNodeId: null, variables, status: "completed", outboundMessages };
}

/**
 * Resumes execution when a WhatsApp delivery status receipt arrives.
 */
export function resumeFlowOnDeliveryStatus(
  def: FlowDefinition,
  state: { currentNodeId: string | null; variables: Record<string, any> },
  deliveryStatus: "delivered" | "read" | "failed",
  errorDetails?: { code?: string; message?: string }
): AdvanceResult {
  if (!state.currentNodeId) {
    return { nextNodeId: null, variables: state.variables, status: "completed", outboundMessages: [] };
  }

  const node = getNode(def, state.currentNodeId);
  if (!node) {
    return { nextNodeId: null, variables: state.variables, status: "completed", outboundMessages: [] };
  }

  const variables = { ...state.variables };
  let nextNodeId: string | null = null;

  if (deliveryStatus === "delivered" || deliveryStatus === "read") {
    variables["_last_delivery_status"] = "delivered";
    nextNodeId = resolvePortNext(node, "delivered");
  } else if (deliveryStatus === "failed") {
    variables["_last_delivery_status"] = "failed";
    if (errorDetails) {
      variables["_last_error_code"] = errorDetails.code || "UNKNOWN";
      variables["_last_error_message"] = errorDetails.message || "Ecosystem error";
    }

    // Check node retry configuration
    const retryConfig = (node as any).retryConfig;
    if (retryConfig?.maxRetries && retryConfig.maxRetries > 0) {
      const retryKey = `_retries_${node.id}`;
      const currentRetries = Number(variables[retryKey] || 0);

      if (currentRetries < retryConfig.maxRetries) {
        variables[retryKey] = currentRetries + 1;
        const retryDelay = retryConfig.delaySeconds || 60;

        // Schedule auto-retry back to the same node
        return {
          nextNodeId: node.id,
          variables,
          status: "waiting",
          outboundMessages: [],
          scheduledResume: {
            delaySeconds: retryDelay,
            targetNodeId: node.id,
          },
        };
      }
    }

    nextNodeId = resolvePortNext(node, "failed");
  }

  if (!nextNodeId) {
    return { nextNodeId: null, variables, status: "completed", outboundMessages: [] };
  }

  // Continue advancing through the target branch
  return advanceFlow(def, { currentNodeId: null, variables }, undefined, nextNodeId);
}
