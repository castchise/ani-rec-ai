import IORedis from "ioredis";
import { Queue } from "bullmq";

export const connection = new IORedis(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  {
    maxRetriesPerRequest: null,
  },
);

export const crawlQueue = new Queue("profile-crawl", { connection });
