import { query, queryOne } from "../../db/pool";
import { createChannel, updateChannel, findWhatsAppChannel, Channel } from "../channels/channels.service";
import { Logger } from "../../utils/logger";

const log = new Logger("meta-onboarding");

/**
 * Meta's Graph API base URL. Overridable so this can be pointed at a local
 * mock for testing — graph.facebook.com isn't reachable from every
 * environment (see IMPLEMENTATION_TRACKER.md for what was and wasn't
 * live-tested).
 */
const GRAPH_API_BASE_URL = process.env.META_GRAPH_API_BASE_URL || "https://graph.facebook.com/v21.0";

export class EmbeddedSignupError extends Error {}

export interface MetaPhoneDetails {
  id: string;
  verified_name?: string;
  display_phone_number?: string;
  quality_rating?: string;
  code_verification_status?: string;
  name_status?: string;
  messaging_limit_tier?: string;
}

export interface MetaWabaDetails {
  id: string;
  name?: string;
  timezone_id?: string;
  currency?: string;
}

/**
 * Step 1 of Embedded Signup completion: the frontend's Meta JS SDK callback
 * hands you a short-lived authorization code. Exchange it for a token you
 * can actually use to call the Graph API on the tenant's behalf.
 *
 * Uses your platform's OWN app id/secret (META_APP_ID/META_APP_SECRET) —
 * this is Tech-Provider-specific: you are the one Meta app every tenant
 * authorizes, not a per-tenant app.
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new EmbeddedSignupError("META_APP_ID / META_APP_SECRET are not configured in backend/.env");
  }

  const url = new URL(`${GRAPH_API_BASE_URL}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);

  log.info("Exchanging OAuth code for permanent access token...");
  const response = await fetch(url.toString());
  if (!response.ok) {
    const errText = await response.text();
    log.error(`Token exchange failed (${response.status}):`, new Error(errText));
    throw new EmbeddedSignupError(`Token exchange failed (${response.status}): ${errText}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new EmbeddedSignupError("Token exchange response missing access_token");
  log.info("Token exchange successful!");
  return data.access_token;
}

/**
 * Inspects the token using Meta debug_token to auto-discover the tenant's
 * WABA ID and associated Phone Number ID if they were not explicitly passed.
 */
export async function inspectTokenForWabaAndPhone(
  accessToken: string
): Promise<{ wabaId?: string; phoneNumberId?: string; verifiedName?: string; displayPhoneNumber?: string }> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return {};

  try {
    const debugUrl = new URL(`${GRAPH_API_BASE_URL}/debug_token`);
    debugUrl.searchParams.set("input_token", accessToken);
    debugUrl.searchParams.set("access_token", `${appId}|${appSecret}`);

    log.info("Inspecting debug_token to discover WABA and Phone Number IDs...");
    const debugRes = await fetch(debugUrl.toString());
    if (!debugRes.ok) {
      log.warn(`debug_token inspect failed (${debugRes.status})`);
      return {};
    }
    const debugData = (await debugRes.json()) as any;
    const granularScopes = debugData?.data?.granular_scopes || [];
    const wabaScope = granularScopes.find(
      (s: any) => s.scope === "whatsapp_business_management" || s.scope === "whatsapp_business_messaging"
    );
    const discoveredWabaId = wabaScope?.target_ids?.[0];

    if (discoveredWabaId) {
      log.info(`Discovered WABA ID from token: ${discoveredWabaId}`);
      // Fetch phone numbers under this discovered WABA
      const phonesUrl = new URL(`${GRAPH_API_BASE_URL}/${discoveredWabaId}/phone_numbers`);
      phonesUrl.searchParams.set("fields", "id,verified_name,display_phone_number,quality_rating");
      const phonesRes = await fetch(phonesUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (phonesRes.ok) {
        const phonesData = (await phonesRes.json()) as any;
        const firstPhone = phonesData?.data?.[0];
        if (firstPhone) {
          log.info(`Discovered Phone Number ID from WABA: ${firstPhone.id}`);
          return {
            wabaId: discoveredWabaId,
            phoneNumberId: firstPhone.id,
            verifiedName: firstPhone.verified_name,
            displayPhoneNumber: firstPhone.display_phone_number,
          };
        }
      }
      return { wabaId: discoveredWabaId };
    }
  } catch (err: any) {
    log.warn("Error discovering WABA/Phone from token:", err?.message || err);
  }
  return {};
}

/**
 * Fetches verified phone number details from Meta Graph API.
 * Retrieves verified_name and display_phone_number.
 */
export async function getMetaPhoneNumberDetails(
  phoneNumberId: string,
  accessToken: string
): Promise<MetaPhoneDetails | null> {
  log.info(`Fetching phone number details for ${phoneNumberId}...`);
  try {
    const url = new URL(`${GRAPH_API_BASE_URL}/${phoneNumberId}`);
    url.searchParams.set(
      "fields",
      "id,verified_name,display_phone_number,quality_rating,code_verification_status,name_status,messaging_limit_tier"
    );
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const errText = await response.text();
      log.warn(`Failed to get phone number details (${response.status}): ${errText}`);
      return null;
    }
    const data = (await response.json()) as MetaPhoneDetails;
    log.info(
      `Phone details: verified_name="${data.verified_name || ""}", display_phone_number="${data.display_phone_number || ""}"`
    );
    return data;
  } catch (err: any) {
    log.warn("Error fetching phone number details:", err?.message || err);
    return null;
  }
}

/**
 * Fetches WABA account details from Meta Graph API.
 */
export async function getMetaWabaDetails(
  wabaId: string,
  accessToken: string
): Promise<MetaWabaDetails | null> {
  log.info(`Fetching WABA details for ${wabaId}...`);
  try {
    const url = new URL(`${GRAPH_API_BASE_URL}/${wabaId}`);
    url.searchParams.set("fields", "id,name,timezone_id,currency");
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const errText = await response.text();
      log.warn(`Failed to get WABA details (${response.status}): ${errText}`);
      return null;
    }
    const data = (await response.json()) as MetaWabaDetails;
    log.info(`WABA details: name="${data.name || ""}"`);
    return data;
  } catch (err: any) {
    log.warn("Error fetching WABA details:", err?.message || err);
    return null;
  }
}

/**
 * Registers the tenant's phone number for Cloud API use.
 * In Meta's Embedded Signup popup flow, the phone number is typically already
 * verified and registered. If Meta responds that registration is unsupported
 * (code 100, subcode 33) or already registered (subcode 133010), this handles it
 * gracefully as a non-fatal warning so onboarding continues.
 */
export async function registerPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  pin: string = "123456"
): Promise<void> {
  log.info(`Registering phone number ${phoneNumberId} with Cloud API...`);
  try {
    const response = await fetch(`${GRAPH_API_BASE_URL}/${phoneNumberId}/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        pin: pin,
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      try {
        const errJson = JSON.parse(errText);
        const msg = errJson?.error?.message || "";
        const code = errJson?.error?.code;
        const subcode = errJson?.error?.error_subcode;
        // If phone number is already registered or verified during the popup flow, continue gracefully
        if (
          msg.includes("already registered") ||
          msg.includes("already verified") ||
          msg.includes("Unsupported post request") ||
          subcode === 133010 ||
          subcode === 33 ||
          code === 100
        ) {
          log.warn(
            `Phone number ${phoneNumberId} registration skipped / already active (code ${code}, subcode ${subcode}): ${msg}`
          );
          return;
        }
      } catch {
        // Not JSON
      }
      log.warn(`Phone number registration non-fatal notice (${response.status}): ${errText}`);
      return;
    }
    log.info(`Phone number ${phoneNumberId} registered successfully!`);
  } catch (err: any) {
    log.warn("Phone number registration non-fatal error:", err?.message || err);
  }
}

/**
 * Subscribes your app to receive webhooks for this tenant's WABA. Without
 * this, Embedded Signup completes and the number is registered, but you
 * never receive their inbound messages.
 */
export async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
  log.info(`Subscribing app to WABA ${wabaId} webhook events...`);
  try {
    const response = await fetch(`${GRAPH_API_BASE_URL}/${wabaId}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const errText = await response.text();
      try {
        const errJson = JSON.parse(errText);
        const msg = errJson?.error?.message || "";
        if (msg.includes("already subscribed") || errJson?.error?.code === 100) {
          log.warn(`WABA ${wabaId} is already subscribed or received notice: ${msg}`);
          return;
        }
      } catch {
        // Not JSON
      }
      log.warn(`Webhook subscription non-fatal notice (${response.status}): ${errText}`);
      return;
    }
    log.info(`WABA ${wabaId} webhook subscription completed!`);
  } catch (err: any) {
    log.warn("Webhook subscription non-fatal error:", err?.message || err);
  }
}

/**
 * Runs the full completion sequence and creates or updates the channel row.
 * Automatically fetches the official Meta verified business name and phone
 * number to use as the display name.
 */
export async function completeEmbeddedSignup(params: {
  tenantId: string;
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
  displayName?: string;
}) {
  let { tenantId, code, wabaId, phoneNumberId, displayName } = params;

  // 1. Exchange OAuth code for permanent access token
  const accessToken = await exchangeCodeForToken(code);

  // 2. Discover missing wabaId or phoneNumberId if not provided
  if (!wabaId || !phoneNumberId) {
    const discovered = await inspectTokenForWabaAndPhone(accessToken);
    if (!wabaId && discovered.wabaId) wabaId = discovered.wabaId;
    if (!phoneNumberId && discovered.phoneNumberId) phoneNumberId = discovered.phoneNumberId;
  }

  if (!wabaId) {
    throw new EmbeddedSignupError("Could not determine WhatsApp Business Account (WABA) ID from Meta.");
  }
  if (!phoneNumberId) {
    throw new EmbeddedSignupError("Could not determine WhatsApp Phone Number ID from Meta.");
  }

  // 3. Register phone number & subscribe to webhooks (non-fatal if already active)
  await registerPhoneNumber(phoneNumberId, accessToken);
  await subscribeAppToWaba(wabaId, accessToken);

  // 4. Fetch official Meta phone number details and WABA details for display name & metadata
  const [metaPhone, metaWaba] = await Promise.all([
    getMetaPhoneNumberDetails(phoneNumberId, accessToken),
    getMetaWabaDetails(wabaId, accessToken),
  ]);

  // Construct official display name from Meta:
  // e.g. "Verified Business (+1 555-123-4567)" or "Verified Business" or "+1 555-123-4567"
  let finalDisplayName = displayName?.trim();
  const verifiedName = metaPhone?.verified_name?.trim();
  const displayPhoneNumber = metaPhone?.display_phone_number?.trim();
  const wabaName = metaWaba?.name?.trim();

  if (verifiedName) {
    finalDisplayName = displayPhoneNumber ? `${verifiedName} (${displayPhoneNumber})` : verifiedName;
  } else if (displayPhoneNumber) {
    finalDisplayName = wabaName ? `${wabaName} (${displayPhoneNumber})` : `WhatsApp (${displayPhoneNumber})`;
  } else if (wabaName) {
    finalDisplayName = `${wabaName} (WhatsApp)`;
  } else if (!finalDisplayName) {
    finalDisplayName = "WhatsApp Business";
  }

  const rawPhone = metaPhone?.display_phone_number?.trim() || "";
  const cleanPhone = rawPhone.replace(/\D/g, "");

  const credentials = {
    wabaId,
    phoneNumberId,
    accessToken,
    apiBaseUrl: GRAPH_API_BASE_URL,
    onboardedVia: "tech-provider-embedded-signup",
    verifiedName: metaPhone?.verified_name,
    displayPhoneNumber: metaPhone?.display_phone_number,
    businessPhoneNumber: cleanPhone || metaPhone?.display_phone_number,
    qualityRating: metaPhone?.quality_rating,
    messagingLimitTier: metaPhone?.messaging_limit_tier,
    messaging_limit_tier: metaPhone?.messaging_limit_tier,
    wabaName: metaWaba?.name,
  };

  // Check if channel already exists for this tenant and phone number / WABA using decrypted credentials
  const existingChannel = await findWhatsAppChannel({
    tenantId,
    phoneNumberId,
    wabaId,
  });

  if (existingChannel) {
    log.info(`Updating existing channel ${existingChannel.id} with fresh Meta credentials...`);
    const updated = await updateChannel(tenantId, existingChannel.id, {
      displayName: finalDisplayName,
      credentials,
      status: "active",
    });
    return updated!;
  }

  log.info(`Creating new channel "${finalDisplayName}" for tenant ${tenantId}...`);
  return createChannel({
    tenantId,
    type: "whatsapp",
    displayName: finalDisplayName,
    credentials,
  });
}

/**
 * Meta defaults new Tech Providers to onboarding 10 new business customers
 * per rolling 7-day window (see architecture doc §4a). This is an
 * account-level Meta limit, not per-tenant, so it's counted across every
 * tenant's WhatsApp channels — hence no tenantId filter here.
 */
export async function getOnboardingCapacity(): Promise<{
  used: number;
  limit: number;
  remaining: number;
  windowDays: number;
}> {
  const LIMIT = 10;
  const WINDOW_DAYS = 7;

  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM channels
     WHERE type = 'whatsapp'
       AND credentials->>'onboardedVia' = 'tech-provider-embedded-signup'
       AND created_at > now() - interval '${WINDOW_DAYS} days'`
  );
  const used = Number(row?.count ?? 0);
  return { used, limit: LIMIT, remaining: Math.max(0, LIMIT - used), windowDays: WINDOW_DAYS };
}
