export interface BroadcastDefinition {
  text?: string; // supports {{name}} interpolation against the contact's name
  flowId?: string; // If set, this broadcast runs a Visual Flow for each recipient
  tags?: string[]; // Tag filter used to generate recipient list
}

export interface FlowCampaignDefinition {
  flowId: string; // Flow ID from the visual flow builder
  tags?: string[];
}

export interface DripStep {
  delayHours: number; // hours after the PREVIOUS step (0 for the first step = send immediately)
  text: string;
}

export interface DripDefinition {
  steps: DripStep[];
}

export function interpolate(template: string, vars: Record<string, string | null>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => vars[key] ?? "");
}
