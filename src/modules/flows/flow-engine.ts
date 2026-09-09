import { FlowDefinition, FlowNode, WaitNode } from "./flows.types";

export interface OutboundFlowMessage {
  type: "text" | "template";
  text?: string;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: Record<string, string>;
  headerType?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";
  headerValue?: string;
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

/**
 * Variable interpolation with support for nested object paths (e.g. {{ contact.name }})
 * and whitespace tolerance.
 */
export function interpolate(template: string, vars: Record<string, any>): string {
  if (!template || typeof template !== "string") return "";
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path) => {
    const parts = path.split(".");
    let curr: any = vars;
    for (const part of parts) {
      if (curr === undefined || curr === null) return "";
      curr = curr[part];
    }
    return curr !== undefined && curr !== null ? String(curr) : "";
  });
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
 * Checks if a node is actively configured to await delivery status receipts.
 */
function isDeliveryWaitingNode(node: FlowNode): boolean {
  if (node.type === "message" || node.type === "template") {
    return Boolean(
      node.waitForDelivery ||
      node.onDelivered ||
      node.onFailed ||
      node.ports?.some((p) => p.id === "delivered" || p.id === "failed")
    );
  }
  return false;
}

/**
 * Resolves the next node pointer from ports, status hooks, or default next.
 */
function resolvePortNext(node: FlowNode, portId: "continue" | "delivered" | "failed" | string): string | null {
  if (portId === "delivered") {
    if ((node as any).onDelivered) return (node as any).onDelivered;
    const foundPort = (node as any).ports?.find((p: any) => p.id === "delivered");
    if (foundPort?.next) return foundPort.next;
    return (node as any).next ?? null;
  }
  if (portId === "failed") {
    if ((node as any).onFailed) return (node as any).onFailed;
    const foundPort = (node as any).ports?.find((p: any) => p.id === "failed");
    if (foundPort?.next) return foundPort.next;
    return null; // Do not fallback to success next on failure
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
export async function advanceFlow(
  def: FlowDefinition,
  state: { currentNodeId: string | null; variables: Record<string, any> },
  incomingText?: string,
  resumeAtNodeId?: string
): Promise<AdvanceResult> {
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
        const shouldWaitForDelivery = isDeliveryWaitingNode(node);

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

        const interpolatedHeaderValue = node.headerValue ? interpolate(node.headerValue, variables) : undefined;
        const shouldWaitForDelivery = isDeliveryWaitingNode(node);

        outboundMessages.push({
          type: "template",
          templateName: node.templateName,
          templateLanguage: node.language || "en",
          templateParams: interpolatedParams,
          headerType: node.headerType,
          headerValue: interpolatedHeaderValue,
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
        const branch = node.branches?.find((b) => b.equals === String(value));
        nodeId = branch?.next ?? node.default ?? null;
        continue;
      }

      case "action": {
        if (node.action === "webhook" && node.url) {
          const interpolatedUrl = interpolate(node.url, variables);
          try {
            console.log(`[flow-engine] webhook action dispatched: ${interpolatedUrl}`);
            const response = await fetch(interpolatedUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ variables }),
              signal: AbortSignal.timeout(5000),
            });
            if (response.ok) {
              try {
                const data = await response.json();
                if (data && typeof data === "object") {
                  Object.assign(variables, data);
                }
              } catch {
                // non-JSON responses are ignored
              }
              nodeId = node.onSuccess || resolvePortNext(node, "continue");
            } else {
              nodeId = node.onFailure || resolvePortNext(node, "continue");
            }
          } catch (err) {
            console.warn(`[flow-engine] webhook action request failed:`, err);
            nodeId = node.onFailure || resolvePortNext(node, "continue");
          }
        } else {
          nodeId = resolvePortNext(node, "continue");
        }
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
export async function resumeFlowOnDeliveryStatus(
  def: FlowDefinition,
  state: { currentNodeId: string | null; variables: Record<string, any> },
  deliveryStatus: "delivered" | "read" | "failed",
  errorDetails?: { code?: string; message?: string }
): Promise<AdvanceResult> {
  if (!state.currentNodeId) {
    return { nextNodeId: null, variables: state.variables, status: "completed", outboundMessages: [] };
  }

  const node = getNode(def, state.currentNodeId);
  if (!node) {
    return { nextNodeId: null, variables: state.variables, status: "completed", outboundMessages: [] };
  }

  // Guard: If the current node is not waiting for delivery (e.g. paused at input node),
  // do not let delivery callbacks advance or interrupt the waiting state.
  if (!isDeliveryWaitingNode(node)) {
    return { nextNodeId: state.currentNodeId, variables: state.variables, status: "running", outboundMessages: [] };
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
