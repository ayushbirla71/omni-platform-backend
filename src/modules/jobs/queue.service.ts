import { Queue, Worker } from "bullmq";

export interface DelayedFlowJobData {
  tenantId: string;
  conversationId: string;
  flowRunId: string;
  targetNodeId: string;
  retryAttempt?: number;
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

function parseRedisOptions(urlStr: string) {
  try {
    const url = new URL(urlStr);
    return {
      host: url.hostname || "localhost",
      port: Number(url.port) || 6379,
      password: url.password || undefined,
      username: url.username || undefined,
      maxRetriesPerRequest: null,
    };
  } catch {
    return { host: "localhost", port: 6379, maxRetriesPerRequest: null };
  }
}

const connection = parseRedisOptions(redisUrl);

export const flowDelayQueue = new Queue<DelayedFlowJobData>("flow-delayed-queue", {
  connection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

let flowWorker: Worker<DelayedFlowJobData> | null = null;

export async function scheduleDelayedFlowResume(
  jobData: DelayedFlowJobData,
  delaySeconds: number
): Promise<void> {
  const delayMs = Math.max(0, Math.floor(delaySeconds * 1000));
  await flowDelayQueue.add("resume-delayed-flow", jobData, {
    delay: delayMs,
  });
  console.log(
    `[job-queue] Scheduled flow resume for conversation ${jobData.conversationId} -> node ${jobData.targetNodeId} after ${delaySeconds}s`
  );
}

export function initFlowDelayWorker(
  handler: (data: DelayedFlowJobData) => Promise<void>
) {
  if (flowWorker) return flowWorker;

  flowWorker = new Worker<DelayedFlowJobData>(
    "flow-delayed-queue",
    async (job: any) => {
      console.log(
        `[job-worker] Executing delayed flow resume for conversation ${job.data.conversationId} -> target node: ${job.data.targetNodeId}`
      );
      await handler(job.data);
    },
    { connection }
  );

  flowWorker.on("failed", (job: any, err: any) => {
    console.error(
      `[job-worker] Delayed flow job failed for conversation ${job?.data.conversationId}:`,
      err
    );
  });

  return flowWorker;
}
