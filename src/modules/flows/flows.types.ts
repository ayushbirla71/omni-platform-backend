/**
 * Flow Builder Type Definitions & AST Specification
 * Supports visual graph nodes, multi-port routing (Continue, Delivered, Failed),
 * asynchronous delivery receipts, Wait/Delay timers, and retry loops.
 */

export interface TemplateButtonAction {
  buttonText: string;
  next: string;
}

export interface NodePort {
  id: string; // "continue" | "delivered" | "failed" | "button_0" etc.
  label?: string;
  next?: string;
}

export interface RetryConfig {
  maxRetries?: number;
  delaySeconds?: number;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle?: string; // e.g. "delivered", "failed", "continue", "btn-0"
  target: string;
  targetHandle?: string;
  label?: string;
}

export type MessageNode = {
  id: string;
  type: "message";
  text: string;
  waitForDelivery?: boolean; // If true, state machine pauses until delivery status webhook arrives
  onDelivered?: string; // Target node ID when WhatsApp returns 'delivered' or 'read'
  onFailed?: string; // Target node ID when WhatsApp returns 'failed' or ecosystem error
  retryConfig?: RetryConfig;
  next?: string; // Default continue next
  ports?: NodePort[];
  position?: NodePosition;
};

export type InputNode = {
  id: string;
  type: "input";
  prompt: string;
  saveAs: string; // variable name the reply gets stored under
  next?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type ConditionNode = {
  id: string;
  type: "condition";
  variable: string;
  branches: { equals: string; next: string }[];
  default?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type ActionNode = {
  id: string;
  type: "action";
  action: "webhook";
  url: string;
  next?: string;
  onSuccess?: string;
  onFailure?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type TemplateNode = {
  id: string;
  type: "template";
  templateName: string;
  language?: string; // e.g. "en", "en_US" (defaults to "en")
  templateParams?: Record<string, string>; // e.g. { "1": "{{userName}}", "2": "Order #123" }
  headerType?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";
  headerValue?: string; // static URL or {{variable}} or text
  buttons?: TemplateButtonAction[];
  waitForDelivery?: boolean;
  onDelivered?: string;
  onFailed?: string;
  retryConfig?: RetryConfig;
  saveAs?: string; // optional variable name to store button tap
  next?: string; // default fallback if no button matched or no buttons
  ports?: NodePort[];
  position?: NodePosition;
};

export type WaitNode = {
  id: string;
  type: "wait";
  duration: number; // e.g. 3600
  durationUnit?: "seconds" | "minutes" | "hours" | "days";
  next?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type AIAgentNode = {
  id: string;
  type: "ai_agent";
  knowledgeBaseId: string;
  queryVariable?: string; // variable containing user query (default: last incoming reply or 'query')
  prompt?: string; // custom system prompt override
  saveResponseAs?: string; // variable to store AI answer (default: 'ai_response')
  sendImmediately?: boolean; // default true (automatically emit answer as outbound message)
  fallbackThreshold?: number; // default 0.2
  onFallback?: string; // target node if confidence is below threshold or error occurs
  next?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type IntentRouterNode = {
  id: string;
  type: "intent_router";
  inputVariable?: string; // variable containing user input (default: last incoming reply)
  branches: { intent: string; next: string }[];
  default?: string;
  saveIntentAs?: string;
  saveSentimentAs?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type HandoffNode = {
  id: string;
  type: "handoff";
  ports?: NodePort[];
  position?: NodePosition;
};

export type EndNode = {
  id: string;
  type: "end";
  ports?: NodePort[];
  position?: NodePosition;
};

export type FlowNode =
  | MessageNode
  | InputNode
  | ConditionNode
  | ActionNode
  | TemplateNode
  | WaitNode
  | AIAgentNode
  | IntentRouterNode
  | HandoffNode
  | EndNode;

export type FlowNodeType = FlowNode["type"];

export interface FlowDefinition {
  entryNodeId: string;
  nodes: FlowNode[];
  edges?: FlowEdge[];
}

export function validateFlowDefinition(def: FlowDefinition): string[] {
  const errors: string[] = [];

  if (!def || typeof def !== "object") {
    return ["Flow definition must be a valid object"];
  }

  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    return ["Flow definition must contain at least one node"];
  }

  const ids = new Set(def.nodes.map((n) => n?.id).filter(Boolean));

  if (!def.entryNodeId) {
    errors.push("entryNodeId is required");
  } else if (!ids.has(def.entryNodeId)) {
    errors.push(`entryNodeId "${def.entryNodeId}" is not a node in this flow`);
  }

  for (const node of def.nodes) {
    if (!node || typeof node !== "object" || !node.id) {
      errors.push("Flow contains an invalid node without an id");
      continue;
    }

    const checkNext = (next?: string) => {
      if (next && !ids.has(next)) errors.push(`Node "${node.id}" points to unknown node "${next}"`);
    };

    switch (node.type) {
      case "message":
        if (!node.text) errors.push(`Node "${node.id}" (message) is missing text`);
        checkNext(node.next);
        checkNext(node.onDelivered);
        checkNext(node.onFailed);
        node.ports?.forEach((p) => checkNext(p.next));
        break;
      case "input":
        if (!node.prompt) errors.push(`Node "${node.id}" (input) is missing prompt`);
        if (!node.saveAs) errors.push(`Node "${node.id}" (input) is missing saveAs`);
        checkNext(node.next);
        node.ports?.forEach((p) => checkNext(p.next));
        break;
      case "condition":
        if (!node.variable) errors.push(`Node "${node.id}" (condition) is missing variable`);
        if (!node.branches?.length && !node.default) errors.push(`Node "${node.id}" (condition) has no branches or default`);
        node.branches?.forEach((b) => checkNext(b.next));
        checkNext(node.default);
        break;
      case "action":
        if (!node.url) errors.push(`Node "${node.id}" (action) is missing url`);
        checkNext(node.next);
        checkNext(node.onSuccess);
        checkNext(node.onFailure);
        break;
      case "template":
        if (!node.templateName) errors.push(`Node "${node.id}" (template) is missing templateName`);
        if (node.buttons && Array.isArray(node.buttons)) {
          node.buttons.forEach((btn, idx) => {
            if (!btn.buttonText) errors.push(`Node "${node.id}" (template) button ${idx} is missing buttonText`);
            checkNext(btn.next);
          });
        }
        checkNext(node.next);
        checkNext(node.onDelivered);
        checkNext(node.onFailed);
        break;
      case "wait":
        if (typeof node.duration !== "number" || node.duration < 0) {
          errors.push(`Node "${node.id}" (wait) must have a valid non-negative duration`);
        }
        checkNext(node.next);
        break;
      case "ai_agent":
        if (!node.knowledgeBaseId) errors.push(`Node "${node.id}" (ai_agent) is missing knowledgeBaseId`);
        checkNext(node.next);
        checkNext(node.onFallback);
        node.ports?.forEach((p) => checkNext(p.next));
        break;
      case "intent_router":
        if (!node.branches?.length && !node.default) {
          errors.push(`Node "${node.id}" (intent_router) has no branches or default`);
        }
        node.branches?.forEach((b) => checkNext(b.next));
        checkNext(node.default);
        node.ports?.forEach((p) => checkNext(p.next));
        break;
      case "handoff":
      case "end":
        break;
      default:
        errors.push(`Node "${(node as any).id}" has an unknown type "${(node as any).type}"`);
        break;
    }
  }

  return errors;
}
