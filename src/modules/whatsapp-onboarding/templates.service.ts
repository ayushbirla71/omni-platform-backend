export interface TemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  text?: string;
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
  buttons?: { type: string; text: string; url?: string; phone_number?: string }[];
}

export interface CreateTemplateInput {
  name: string;
  language: string; // e.g. "en_US"
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  components: TemplateComponent[];
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string; // APPROVED | PENDING | REJECTED
  components: TemplateComponent[];
}

/**
 * Every call needs the tenant's own WABA id + access token (from their
 * channel credentials) — templates are submitted and approved per-WABA,
 * not globally. This is the Tech Provider difference: a Solution Partner
 * customer wouldn't call the Graph API directly for this at all.
 */
export async function listTemplates(
  wabaId: string,
  accessToken: string,
  apiBaseUrl: string
): Promise<WhatsAppTemplate[]> {
  const response = await fetch(`${apiBaseUrl}/${wabaId}/message_templates`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to list templates (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { data: WhatsAppTemplate[] };
  return data.data ?? [];
}

export async function createTemplate(
  wabaId: string,
  accessToken: string,
  apiBaseUrl: string,
  template: CreateTemplateInput
): Promise<{ id: string; status: string; category: string }> {
  const response = await fetch(`${apiBaseUrl}/${wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(template),
  });
  if (!response.ok) {
    throw new Error(`Failed to create template (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<{ id: string; status: string; category: string }>;
}
