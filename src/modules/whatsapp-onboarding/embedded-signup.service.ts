import { query, queryOne } from "../../db/pool";
import { createChannel } from "../channels/channels.service";

/**
 * Meta's Graph API base URL. Overridable so this can be pointed at a local
 * mock for testing — graph.facebook.com isn't reachable from every
 * environment (see IMPLEMENTATION_TRACKER.md for what was and wasn't
 * live-tested).
 */
const GRAPH_API_BASE_URL = process.env.META_GRAPH_API_BASE_URL || "https://graph.facebook.com/v21.0";

export class EmbeddedSignupError extends Error {}

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

  console.log(`[Meta Onboarding] Exchanging OAuth code for permanent access token...`);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Meta Onboarding] Token exchange failed (${response.status}):`, errText);
    throw new EmbeddedSignupError(`Token exchange failed (${response.status}): ${errText}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new EmbeddedSignupError("Token exchange response missing access_token");
  console.log(`[Meta Onboarding] Token exchange successful!`);
  return data.access_token;
}

/**
 * Registers the tenant's phone number for Cloud API use. Required once per
 * number before it can send/receive via the API — Embedded Signup gets the
 * number onto your app's WABA, but registration is a separate explicit step.
 * Meta Cloud API requires a 6-digit pin for two-step verification registration.
 */
export async function registerPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  pin: string = "123456"
): Promise<void> {
  console.log(`[Meta Onboarding] Registering phone number ${phoneNumberId} with Cloud API...`);
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
      // If phone number is already registered or verified during the popup flow, continue gracefully
      if (
        msg.includes("already registered") ||
        msg.includes("already verified") ||
        errJson?.error?.error_subcode === 133010
      ) {
        console.warn(`[Meta Onboarding] Phone number ${phoneNumberId} is already registered:`, msg);
        return;
      }
    } catch {
      // Not JSON
    }
    console.error(`[Meta Onboarding] Phone number registration failed (${response.status}):`, errText);
    throw new EmbeddedSignupError(`Phone number registration failed (${response.status}): ${errText}`);
  }
  console.log(`[Meta Onboarding] Phone number ${phoneNumberId} registered successfully!`);
}

/**
 * Subscribes your app to receive webhooks for this tenant's WABA. Without
 * this, Embedded Signup completes and the number is registered, but you
 * never receive their inbound messages.
 */
export async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
  console.log(`[Meta Onboarding] Subscribing app to WABA ${wabaId} webhook events...`);
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
        console.warn(`[Meta Onboarding] WABA ${wabaId} is already subscribed or received notice:`, msg);
        return;
      }
    } catch {
      // Not JSON
    }
    console.error(`[Meta Onboarding] Webhook subscription failed (${response.status}):`, errText);
    throw new EmbeddedSignupError(`Webhook subscription failed (${response.status}): ${errText}`);
  }
  console.log(`[Meta Onboarding] WABA ${wabaId} webhook subscription completed!`);
}

/**
 * Runs the full completion sequence and creates the channel row. This is
 * what POST /api/whatsapp-onboarding/callback calls.
 */
export async function completeEmbeddedSignup(params: {
  tenantId: string;
  code: string;
  wabaId: string;
  phoneNumberId: string;
  displayName: string;
}) {
  const { tenantId, code, wabaId, phoneNumberId, displayName } = params;

  const accessToken = await exchangeCodeForToken(code);
  await registerPhoneNumber(phoneNumberId, accessToken);
  await subscribeAppToWaba(wabaId, accessToken);

  return createChannel({
    tenantId,
    type: "whatsapp",
    displayName,
    credentials: {
      wabaId,
      phoneNumberId,
      accessToken,
      apiBaseUrl: GRAPH_API_BASE_URL,
      onboardedVia: "tech-provider-embedded-signup",
    },
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
