export interface BroadcastDefinition {
  text?: string; // supports {{name}} interpolation against the contact's name
  flowId?: string; // If set, this broadcast runs a Visual Flow for each recipient
  tags?: string[]; // Tag filter used to generate recipient list
  templateName?: string;
  templateLanguage?: string;
  templateParams?: Record<string, string>;
  headerType?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";
  headerValue?: string;
  mediaStorageKey?: string;
  filename?: string;
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
