import IORedis from "ioredis";
import { Queue } from "bullmq";

export const embedConnection = new IORedis(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  { maxRetriesPerRequest: null },
);

export const embedQueue = new Queue("anime-embed", {
  connection: embedConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3_000 },
    removeOnComplete: { count: 0 },
    removeOnFail: { count: 200 },
  },
});
