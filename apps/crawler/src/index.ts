import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import { JikanClient } from "@ani-rec-ai/jikan-client";
import { db, crawledProfiles } from "@ani-rec-ai/db";

const connection = new IORedis(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  {
    maxRetriesPerRequest: null,
  },
);

export const crawlQueue = new Queue("profile-crawl", { connection });

// JikanClient's internal throttle handles per-instance rate limiting.
// concurrency: 1 + BullMQ limiter ensures we never fire parallel Jikan
// requests from this process, staying safely under 3 req/sec globally.
const jikan = new JikanClient();

const worker = new Worker(
  "profile-crawl",
  async (job) => {
    const { username } = job.data as { username: string };
    console.log(`Crawling: ${username}`);

    // Skip profiles already crawled
    const existing = await db.query.crawledProfiles.findFirst({
      where: (t, { eq }) => eq(t.malUsername, username),
    });
    if (existing) return;

    const list = await jikan.getUserAnimeList(username, "completed");
    // TODO: upsert ratings to db
    console.log(`  ${username}: ${list.length} completed entries`);

    // Expand the graph via friends
    const friends = await jikan.getUserFriends(username);
    for (const friend of friends) {
      await crawlQueue.add(
        "profile-crawl",
        { username: friend },
        {
          jobId: `crawl:${friend}`, // jobId deduplicates — safe to add duplicates
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      );
    }
  },
  {
    connection,
    concurrency: 1, // never run two Jikan calls in parallel
    limiter: { max: 2, duration: 1000 }, // max 2 jobs/sec — under Jikan's 3/sec limit
  },
);

worker.on("completed", (job) => console.log(`Done: ${job.data.username}`));
worker.on("failed", (job, err) =>
  console.error(`Failed: ${job?.data.username}`, err.message),
);
