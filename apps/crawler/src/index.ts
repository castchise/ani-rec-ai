import { Worker } from "bullmq";
import { JikanClient } from "@ani-rec-ai/jikan-client";
import { db, crawledProfiles, users, userAnimeList, sql } from "@ani-rec-ai/db";
import { connection, crawlQueue } from "./queue";

const jikan = new JikanClient();

const worker = new Worker(
  "profile-crawl",
  async (job) => {
    const { username } = job.data as { username: string };
    const malUsername = username.toLowerCase();
    console.log(`Crawling: ${malUsername}`);

    // Skip profiles already crawled — use select instead of relational query
    // so no relations() definition is required
    const existing = await db
      .select()
      .from(crawledProfiles)
      .where(sql`${crawledProfiles.malUsername} = ${malUsername}`)
      .limit(1);

    if (existing.length > 0) {
      console.log(`  ${malUsername}: already crawled, skipping`);
      return;
    }

    let list: Awaited<ReturnType<typeof jikan.getUserAnimeList>>;
    try {
      list = await jikan.getUserAnimeList(malUsername, "completed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${malUsername}: Jikan error — ${msg}`);
      if (msg.includes("404") || msg.includes("403")) {
        await db.insert(crawledProfiles).values({
          malUsername,
          ratingCount: 0,
          isPrivate: true,
        });
        console.log(`  ${malUsername}: marked as private/not found`);
        return;
      }
      throw err; // re-throw so BullMQ retries (rate limits, 5xx, etc.)
    }

    console.log(`  ${malUsername}: ${list.length} completed entries`);

    if (list.length > 0) {
      // Upsert user row — returns the id whether inserted or already existed
      const [user] = await db
        .insert(users)
        .values({ malUsername })
        .onConflictDoUpdate({
          target: users.malUsername,
          set: { listLastSynced: new Date() },
        })
        .returning({ id: users.id });

      const userId = user!.id;

      // Only scored entries are useful for collaborative filtering
      const scored = list.filter((e) => (e.score ?? 0) > 0);

      if (scored.length > 0) {
        const rows = scored.map((e) => ({
          userId,
          animeId: e.animeId,
          score: e.score ?? null,
          status: e.status as
            | "completed"
            | "watching"
            | "on_hold"
            | "dropped"
            | "plan_to_watch",
          updatedAt: new Date(e.updatedAt),
        }));

        await db
          .insert(userAnimeList)
          .values(rows)
          .onConflictDoUpdate({
            target: [userAnimeList.userId, userAnimeList.animeId],
            set: {
              score: sql`excluded.score`,
              status: sql`excluded.status`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }

      await db.insert(crawledProfiles).values({
        malUsername,
        ratingCount: scored.length,
        isPrivate: false,
      });

      console.log(`  ${malUsername}: saved ${scored.length} scored entries`);
    }

    // Expand graph via friends
    const friends = await jikan.getUserFriends(malUsername);
    console.log(`  ${malUsername}: queuing ${friends.length} friends`);
    for (const friend of friends) {
      await crawlQueue.add(
        "profile-crawl",
        { username: friend.toLowerCase() },
        {
          jobId: `crawl_${friend.toLowerCase()}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      );
    }
  },
  {
    connection,
    concurrency: 1,
    limiter: { max: 2, duration: 1000 },
    removeOnComplete: { count: 0 }, // don't keep completed jobs — prevents jobId dedup blocking re-runs
    removeOnFail: { count: 100 }, // keep last 100 failed for debugging
  },
);

worker.on("completed", (job) => console.log(`Done: ${job.data.username}`));
worker.on("failed", (job, err) =>
  console.error(`Failed: ${job?.data.username} —`, err.message),
);
worker.on("active", (job) => console.log(`Processing: ${job.data.username}`));

console.log("Worker started, waiting for jobs...");
