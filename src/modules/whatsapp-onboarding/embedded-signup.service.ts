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
    throw new EmbeddedSignupError("META_APP_ID / META_APP_SECRET are not configured");
  }

  const url = new URL(`${GRAPH_API_BASE_URL}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const errText = await response.text();
    throw new EmbeddedSignupError(`Token exchange failed (${response.status}): ${errText}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new EmbeddedSignupError("Token exchange response missing access_token");
  return data.access_token;
}

/**
 * Registers the tenant's phone number for Cloud API use. Required once per
 * number before it can send/receive via the API — Embedded Signup gets the
 * number onto your app's WABA, but registration is a separate explicit step.
 */
export async function registerPhoneNumber(phoneNumberId: string, accessToken: string): Promise<void> {
  const response = await fetch(`${GRAPH_API_BASE_URL}/${phoneNumberId}/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp" }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new EmbeddedSignupError(`Phone number registration failed (${response.status}): ${errText}`);
  }
}

/**
 * Subscribes your app to receive webhooks for this tenant's WABA. Without
 * this, Embedded Signup completes and the number is registered, but you
 * never receive their inbound messages.
 */
export async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
  const response = await fetch(`${GRAPH_API_BASE_URL}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new EmbeddedSignupError(`Webhook subscription failed (${response.status}): ${errText}`);
  }
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
