import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";

import { logger } from "./utils/logger";
import { requestLogger } from "./middleware/request-logger";
import { errorHandler } from "./middleware/error-handler";

import { authRouter } from "./modules/auth/auth.routes";
import { channelsRouter } from "./modules/channels/channels.routes";
import { contactsRouter } from "./modules/contacts/contacts.routes";
import { conversationsRouter } from "./modules/conversations/conversations.routes";
import { webhooksRouter } from "./modules/webhooks/webhooks.routes";
import { flowsRouter } from "./modules/flows/flows.routes";
import { dealsRouter } from "./modules/deals/deals.routes";
import { campaignsRouter } from "./modules/campaigns/campaigns.routes";
import { linksRouter } from "./modules/links/links.routes";
import { processDueDripSteps } from "./modules/campaigns/campaign-sender";
import { whatsappOnboardingRouter } from "./modules/whatsapp-onboarding/embedded-signup.routes";
import { templatesRouter } from "./modules/whatsapp-onboarding/templates.routes";
import { searchRouter } from "./modules/search/search.routes";
import { mediaRouter } from "./modules/media/media.routes";
import { systemRouter } from "./modules/system/system.routes";
import { productsRouter } from "./modules/commerce/products.routes";
import { ordersRouter } from "./modules/commerce/orders.routes";
import { paymentsRouter, paymentWebhooksRouter } from "./modules/commerce/payments.routes";
import { knowledgeBaseRouter } from "./modules/ai/knowledge-base.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { ensureMediaBucketExists } from "./db/object-storage";
import { ensureSearchIndices } from "./db/elasticsearch";

import { runFlowForConversation } from "./modules/flows/flow-engine-runner";
import { initFlowDelayWorker } from "./modules/jobs/queue.service";

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(requestLogger);
/**
 * Capturing the raw bytes here (before parsing) is required for correct
 * webhook signature verification. Meta signs the literal request body it
 * sent, not a re-serialization of the parsed JSON — those two can differ in
 * whitespace, so re-serializing with JSON.stringify(req.body) and hashing
 * THAT (the original, buggier approach) only happens to work when the
 * sender's formatting coincidentally matches JSON.stringify's compact
 * output. See src/modules/webhooks/webhooks.routes.ts, which uses
 * req.rawBody instead.
 */
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRouter);
app.use("/api/channels", channelsRouter);
app.use("/api/channels", linksRouter); // adds GET /api/channels/:channelId/deep-link
app.use("/api/contacts", contactsRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api/flows", flowsRouter);
app.use("/api/deals", dealsRouter);
app.use("/api/campaigns", campaignsRouter);
app.use("/api/whatsapp-onboarding", whatsappOnboardingRouter);
app.use("/api/channels", templatesRouter); // adds GET/POST /api/channels/:channelId/templates
app.use("/api/search", searchRouter);
app.use("/api/media", mediaRouter);
app.use("/api/system", systemRouter);
app.use("/api/products", productsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/knowledge-bases", knowledgeBaseRouter);
app.use("/api/ai", aiRouter);
app.use("/webhooks/payments", paymentWebhooksRouter);
app.use("/webhooks", webhooksRouter);

// Global production-grade error handler
app.use(errorHandler);

process.on("unhandledRejection", (reason: any) => {
  logger.error(
    "Unhandled promise rejection (check for a raw Promise outside asyncHandler):",
    reason instanceof Error ? reason : new Error(String(reason))
  );
});

process.on("uncaughtException", (err: Error) => {
  logger.fatal("Uncaught Exception thrown in Node process:", err);
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  logger.info(`omni-platform backend listening on :${port}`);
});

/**
 * Bucket auto-creation only makes sense against a local/dev MinIO — see the
 * comment on ensureMediaBucketExists. Real AWS S3 usage should leave
 * MEDIA_S3_ENDPOINT unset and provision the bucket via infra tooling
 * instead. Either way, a storage outage at boot shouldn't crash the API —
 * media features degrade, the rest of the app still works.
 */
if (process.env.MEDIA_S3_ENDPOINT) {
  ensureMediaBucketExists().catch((err) =>
    console.error("[startup] failed to ensure media bucket exists (non-fatal):", err)
  );
}

/**
 * Same non-fatal-at-boot treatment for Elasticsearch — see
 * IMPLEMENTATION_TRACKER.md for why this hasn't been live-tested in every
 * environment. Search degrades gracefully if this fails; message/webhook
 * handling never depends on it.
 */
ensureSearchIndices().catch((err) =>
  console.error("[startup] failed to ensure Elasticsearch indices exist (non-fatal):", err)
);

/**
 * Drip-campaign polling. This is a stand-in for a real scheduler/job queue
 * (see architecture doc §7 and the comment on processDueDripSteps) — good
 * enough for development and low volume, not for production scale. The
 * interval is configurable via DRIP_POLL_INTERVAL_MS (defaults to 30s) —
 * a step can fire up to one interval late, fine for hour/day-granularity
 * drip delays but worth knowing.
 */
const DRIP_POLL_INTERVAL_MS = Number(process.env.DRIP_POLL_INTERVAL_MS) || 30_000;
setInterval(async () => {
  try {
    const result = await processDueDripSteps();
    if (result.processed || result.failed) {
      console.log(`[drip-scheduler] processed=${result.processed} failed=${result.failed}`);
    }
  } catch (err) {
    console.error("[drip-scheduler] error running due steps", err);
  }
}, DRIP_POLL_INTERVAL_MS);

/**
 * Initialize BullMQ Flow Delay Worker for Wait nodes & automated retry loops
 */
initFlowDelayWorker(async (jobData) => {
  try {
    await runFlowForConversation({
      tenantId: jobData.tenantId,
      conversationId: jobData.conversationId,
      defaultFlowId: null,
      resumeAtNodeId: jobData.targetNodeId,
    });
  } catch (err) {
    console.error(`[flow-delay-worker] Error resuming flow for conversation ${jobData.conversationId}:`, err);
  }
});
