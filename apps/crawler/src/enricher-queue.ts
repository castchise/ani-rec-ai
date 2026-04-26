import IORedis from "ioredis";
import { Queue } from "bullmq";

// Reuse the same Redis connection string as the crawl queue but keep a
// dedicated Queue instance so the two workloads don't share a namespace.
export const enrichConnection = new IORedis(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  { maxRetriesPerRequest: null },
);

export const enrichQueue = new Queue("anime-enrich", {
  connection: enrichConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { count: 0 },
    removeOnFail: { count: 200 },
  },
});
