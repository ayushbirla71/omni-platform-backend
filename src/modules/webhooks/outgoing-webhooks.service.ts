import { v4 as uuidv4 } from "uuid";
import { query, queryOne } from "../../db/pool";
import { generateHmacSignature, generateWebhookSecret } from "../../utils/crypto";
import { logger } from "../../utils/logger";

export interface WebhookSubscription {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  is_active: boolean;
  failure_count: number;
  last_triggered_at: string | null;
  last_status_code: number | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryLog {
  id: string;
  tenant_id: string;
  subscription_id: string;
  event: string;
  payload: any;
  response_status: number | null;
  response_body: string | null;
  duration_ms: number;
  attempt: number;
  status: "success" | "failed" | "retrying";
  created_at: string;
}

export async function createWebhookSubscription(params: {
  tenantId: string;
  name: string;
  url: string;
  secret?: string;
  events?: string[];
}): Promise<WebhookSubscription> {
  const { tenantId, name, url } = params;
  const secret = params.secret || generateWebhookSecret();
  const events = params.events && params.events.length > 0 ? params.events : ["*"];

  const row = await queryOne<WebhookSubscription>(
    `INSERT INTO webhook_subscriptions (tenant_id, name, url, secret, events, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [tenantId, name, url, secret, JSON.stringify(events)]
  );

  return row!;
}

export async function listWebhookSubscriptions(tenantId: string): Promise<WebhookSubscription[]> {
  return query<WebhookSubscription>(
    `SELECT * FROM webhook_subscriptions
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId]
  );
}

export async function getWebhookSubscription(
  tenantId: string,
  id: string
): Promise<WebhookSubscription | null> {
  return queryOne<WebhookSubscription>(
    `SELECT * FROM webhook_subscriptions
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
}

export async function updateWebhookSubscription(
  tenantId: string,
  id: string,
  updates: {
    name?: string;
    url?: string;
    secret?: string;
    events?: string[];
    is_active?: boolean;
  }
): Promise<WebhookSubscription | null> {
  const existing = await getWebhookSubscription(tenantId, id);
  if (!existing) return null;

  const name = updates.name !== undefined ? updates.name : existing.name;
  const url = updates.url !== undefined ? updates.url : existing.url;
  const secret = updates.secret !== undefined ? updates.secret : existing.secret;
  const events = updates.events !== undefined ? JSON.stringify(updates.events) : JSON.stringify(existing.events);
  const isActive = updates.is_active !== undefined ? updates.is_active : existing.is_active;

  const row = await queryOne<WebhookSubscription>(
    `UPDATE webhook_subscriptions
     SET name = $1,
         url = $2,
         secret = $3,
         events = $4,
         is_active = $5,
         updated_at = now()
     WHERE tenant_id = $6 AND id = $7
     RETURNING *`,
    [name, url, secret, events, isActive, tenantId, id]
  );

  return row;
}

export async function deleteWebhookSubscription(tenantId: string, id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM webhook_subscriptions
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return result.length >= 0;
}

export async function listWebhookDeliveryLogs(
  tenantId: string,
  subscriptionId?: string,
  limit: number = 50
): Promise<WebhookDeliveryLog[]> {
  const conditions = ["tenant_id = $1"];
  const params: any[] = [tenantId];

  if (subscriptionId) {
    params.push(subscriptionId);
    conditions.push(`subscription_id = $${params.length}`);
  }

  params.push(Math.min(limit, 100));

  return query<WebhookDeliveryLog>(
    `SELECT * FROM webhook_delivery_logs
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
}

/**
 * Executes direct HTTP POST delivery of a webhook event to a subscription endpoint.
 * Signs payload with HMAC-SHA256 and records delivery audit log.
 */
export async function executeWebhookDelivery(
  subscription: WebhookSubscription,
  event: string,
  payload: any,
  attempt: number = 1
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const deliveryId = uuidv4();
  const timestamp = new Date().toISOString();
  const serializedBody = JSON.stringify({
    id: deliveryId,
    event,
    timestamp,
    tenant_id: subscription.tenant_id,
    data: payload,
  });

  const signature = generateHmacSignature(serializedBody, subscription.secret);
  const startTime = Date.now();

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let status: "success" | "failed" = "failed";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(subscription.url, {
      method: "POST",
      body: serializedBody,
      headers: {
        "Content-Type": "application/json",
        "X-Omni-Signature": signature,
        "X-Omni-Event": event,
        "X-Omni-Delivery": deliveryId,
        "X-Omni-Timestamp": timestamp,
        "User-Agent": "OmniPlatform-Webhook-Dispatcher/1.0",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const durationMs = Date.now() - startTime;
    responseStatus = response.status;
    const rawText = await response.text();
    responseBody = rawText.slice(0, 1000);

    status = response.status >= 200 && response.status < 300 ? "success" : "failed";

    // Insert delivery log
    await query(
      `INSERT INTO webhook_delivery_logs (
         id, tenant_id, subscription_id, event, payload,
         response_status, response_body, duration_ms, attempt, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        deliveryId,
        subscription.tenant_id,
        subscription.id,
        event,
        JSON.stringify(payload),
        responseStatus,
        responseBody,
        durationMs,
        attempt,
        status,
      ]
    );

    // Update subscription statistics
    if (status === "success") {
      await query(
        `UPDATE webhook_subscriptions
         SET last_triggered_at = now(),
             last_status_code = $1,
             failure_count = 0,
             updated_at = now()
         WHERE id = $2`,
        [responseStatus, subscription.id]
      );
    } else {
      await query(
        `UPDATE webhook_subscriptions
         SET last_triggered_at = now(),
             last_status_code = $1,
             failure_count = failure_count + 1,
             updated_at = now()
         WHERE id = $2`,
        [responseStatus, subscription.id]
      );
    }

    return { success: status === "success", statusCode: responseStatus || undefined };
  } catch (err: any) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    const errorMessage = err?.name === "AbortError" ? "Request timeout after 10000ms" : err?.message || "Unknown network error";

    await query(
      `INSERT INTO webhook_delivery_logs (
         id, tenant_id, subscription_id, event, payload,
         response_status, response_body, duration_ms, attempt, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        deliveryId,
        subscription.tenant_id,
        subscription.id,
        event,
        JSON.stringify(payload),
        null,
        `Network error: ${errorMessage}`.slice(0, 1000),
        durationMs,
        attempt,
        "failed",
      ]
    );

    await query(
      `UPDATE webhook_subscriptions
       SET last_triggered_at = now(),
           failure_count = failure_count + 1,
           updated_at = now()
       WHERE id = $1`,
      [subscription.id]
    );

    logger.warn("Outbound webhook dispatch network error", {
      subscriptionId: subscription.id,
      url: subscription.url,
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
}

/**
 * Dispatch an outbound event across all matching active webhook subscriptions for a tenant.
 */
export async function dispatchWebhookEvent(
  tenantId: string,
  event: string,
  payload: any
): Promise<void> {
  try {
    const subscriptions = await query<WebhookSubscription>(
      `SELECT * FROM webhook_subscriptions
       WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    );

    for (const sub of subscriptions) {
      const eventsList: string[] = Array.isArray(sub.events) ? sub.events : [];
      const matches = eventsList.includes("*") || eventsList.includes(event);
      if (!matches) continue;

      // Asynchronously deliver
      executeWebhookDelivery(sub, event, payload).catch((err) => {
        logger.error("Error executing background webhook delivery", {
          subscriptionId: sub.id,
          error: err?.message,
        });
      });
    }
  } catch (err: any) {
    logger.error("Failed to query webhook subscriptions for event dispatch", {
      tenantId,
      event,
      error: err?.message,
    });
  }
}
