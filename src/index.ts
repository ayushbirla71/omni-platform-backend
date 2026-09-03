import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

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
import { ensureMediaBucketExists } from "./db/object-storage";
import { ensureSearchIndices } from "./db/elasticsearch";

import { runFlowForConversation } from "./modules/flows/flow-engine-runner";
import { initFlowDelayWorker } from "./modules/jobs/queue.service";

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
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
app.use("/webhooks", webhooksRouter);

/**
 * Safety net. Per-route try/catch that gives a specific, helpful message
 * (like the contactId/channelId checks in deals & campaigns) is still
 * better than this — but every route is now wrapped in asyncHandler
 * (see src/middleware/async-handler.ts), so any route WITHOUT its own
 * try/catch lands here instead of hanging with no response, which is
 * the bug this whole thing exists to prevent.
 */
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled route error:", err);
  if (res.headersSent) return;

  // Common Postgres constraint violation codes get a real 400 instead of a
  // generic 500 — see https://www.postgresql.org/docs/current/errcodes-summary.html
  if (err?.code === "23503") {
    return res.status(400).json({ error: "Request refers to a record that does not exist" });
  }
  if (err?.code === "23505") {
    return res.status(409).json({ error: "A record with these values already exists" });
  }
  if (err?.code === "23514" || err?.code === "22P02") {
    return res.status(400).json({ error: "Request contains an invalid value" });
  }

  res.status(500).json({ error: "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (should no longer be reachable via a route — check for a raw Promise outside asyncHandler):", reason);
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`omni-platform backend listening on :${port}`);
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
