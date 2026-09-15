export interface TemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  text?: string;
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  example?: {
    header_text?: string[];
    header_handle?: string[];
    header_url?: string[];
    body_text?: string[][];
  };
  buttons?: Array<{
    type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE" | "OTP" | "CATALOG" | "MPM" | string;
    text?: string;
    url?: string;
    phone_number?: string;
    example?: string | string[];
    otp_type?: "COPY_CODE" | "ONE_TAP" | "ZERO_TAP";
    autofill_text?: string;
    package_name?: string;
    signature_hash?: string;
    [key: string]: any;
  }>;
  [key: string]: any;
}

export interface CreateTemplateInput {
  name: string;
  language: string; // e.g. "en_US"
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION" | string;
  components: TemplateComponent[];
}

export interface WhatsAppTemplate {
  id?: string;
  name: string;
  language: string;
  category: string;
  status: string; // APPROVED | PENDING | REJECTED | PAUSED | IN_APPEAL | DELETED
  components: TemplateComponent[];
  rejected_reason?: string;
  quality_score?: { score: string };
  [key: string]: any;
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
  const url = `${apiBaseUrl}/${wabaId}/message_templates?fields=name,status,category,language,components,id,rejected_reason,quality_score&limit=100`;
  console.log(`[Templates] Fetching message templates from Meta WABA: ${wabaId}...`);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Templates] Meta API returned ${response.status} for WABA ${wabaId}:`, errText);
    let errMsg = `Meta API error (${response.status})`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson?.error?.message) {
        errMsg = `Meta: ${errJson.error.message}`;
        if (errJson.error.error_user_msg) {
          errMsg += ` (${errJson.error.error_user_msg})`;
        }
      }
    } catch {
      errMsg = `Failed to list templates (${response.status}): ${errText}`;
    }
    throw new Error(errMsg);
  }
  const data = (await response.json()) as { data?: WhatsAppTemplate[] };
  return data.data ?? [];
}

export async function createTemplate(
  wabaId: string,
  accessToken: string,
  apiBaseUrl: string,
  template: CreateTemplateInput
): Promise<{ id: string; status: string; category: string }> {
  const url = `${apiBaseUrl}/${wabaId}/message_templates`;
  console.log(`[Templates] Submitting message template "${template.name}" to Meta WABA: ${wabaId}...`);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(template),
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Templates] Meta template creation returned ${response.status}:`, errText);
    let errMsg = `Meta API error (${response.status})`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson?.error?.message) {
        errMsg = `Meta: ${errJson.error.message}`;
        if (errJson.error.error_user_msg) {
          errMsg += ` (${errJson.error.error_user_msg})`;
        }
        if (errJson.error.error_data?.details) {
          errMsg += ` - ${errJson.error.error_data.details}`;
        }
      }
    } catch {
      errMsg = `Failed to create template (${response.status}): ${errText}`;
    }
    throw new Error(errMsg);
  }
  return response.json() as Promise<{ id: string; status: string; category: string }>;
}

export async function deleteTemplate(
  wabaId: string,
  accessToken: string,
  apiBaseUrl: string,
  templateName: string,
  templateId?: string
): Promise<{ success: boolean }> {
  const url = templateId
    ? `${apiBaseUrl}/${templateId}`
    : `${apiBaseUrl}/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}`;
  console.log(`[Templates] Deleting message template "${templateName || templateId}" on Meta WABA: ${wabaId}...`);
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Templates] Meta template deletion returned ${response.status}:`, errText);
    let errMsg = `Meta API error (${response.status})`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson?.error?.message) {
        errMsg = `Meta: ${errJson.error.message}`;
      }
    } catch {
      errMsg = `Failed to delete template (${response.status}): ${errText}`;
    }
    throw new Error(errMsg);
  }
  return { success: true };
}
