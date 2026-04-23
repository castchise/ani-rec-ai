import { Worker } from "bullmq";
import { MalClient, JikanClient } from "@ani-rec-ai/api-clients";
import {
  db,
  crawledProfiles,
  users,
  userAnimeList,
  anime,
  sql,
} from "@ani-rec-ai/db";
import { connection, crawlQueue } from "./queue";

const malClientId = process.env.MAL_CLIENT_ID;
if (!malClientId) throw new Error("MAL_CLIENT_ID is not set");

const mal = new MalClient(malClientId);
const jikan = new JikanClient(); // still used for friend graph expansion

const worker = new Worker(
  "profile-crawl",
  async (job) => {
    const { username } = job.data as { username: string };
    const malUsername = username.toLowerCase();
    console.log(`Crawling: ${malUsername}`);

    // Skip profiles already crawled
    const existing = await db
      .select()
      .from(crawledProfiles)
      .where(sql`${crawledProfiles.malUsername} = ${malUsername}`)
      .limit(1);

    if (existing.length > 0) {
      console.log(`  ${malUsername}: already crawled, skipping`);
      return;
    }

    let list: Awaited<ReturnType<typeof mal.getUserAnimeList>>;
    try {
      list = await mal.getUserAnimeList(malUsername, "completed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${malUsername}: MAL API error — ${msg}`);
      if (msg.startsWith("403") || msg.startsWith("404")) {
        await db.insert(crawledProfiles).values({
          malUsername,
          ratingCount: 0,
          isPrivate: true,
        });
        console.log(`  ${malUsername}: marked as private/not found`);
        return;
      }
      throw err;
    }

    console.log(`  ${malUsername}: ${list.length} completed entries`);

    if (list.length > 0) {
      // Upsert user row
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
        // --- Step 1: upsert anime stubs to satisfy FK constraint ---
        // user_anime_list.anime_id references anime.id (onDelete cascade).
        // The anime table may be empty at crawl time; insert minimal stubs so
        // the FK is satisfied. Real metadata is enriched separately (Phase 2).
        const animeStubs = scored.map((e) => ({
          id: e.animeId,
          title: e.animeTitle ?? `Anime #${e.animeId}`, // title is notNull
        }));

        // Chunk into batches of 500 to stay under postgres parameter limits
        const CHUNK = 500;
        for (let i = 0; i < animeStubs.length; i += CHUNK) {
          const chunk = animeStubs.slice(i, i + CHUNK);
          await db.insert(anime).values(chunk).onConflictDoNothing(); // keep existing enriched data if already present
        }

        // --- Step 2: upsert list entries ---
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

        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          await db
            .insert(userAnimeList)
            .values(chunk)
            .onConflictDoUpdate({
              target: [userAnimeList.userId, userAnimeList.animeId],
              set: {
                score: sql`excluded.score`,
                status: sql`excluded.status`,
                updatedAt: sql`excluded.updated_at`,
              },
            });
        }
      }

      await db.insert(crawledProfiles).values({
        malUsername,
        ratingCount: scored.length,
        isPrivate: false,
      });

      console.log(`  ${malUsername}: saved ${scored.length} scored entries`);
    }

    // Expand graph via Jikan friends endpoint (not deprecated)
    try {
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
    } catch {
      console.warn(
        `  ${malUsername}: could not fetch friends, skipping graph expansion`,
      );
    }
  },
  {
    connection,
    concurrency: 1,
    limiter: { max: 2, duration: 1000 },
    removeOnComplete: { count: 0 },
    removeOnFail: { count: 100 },
  },
);

worker.on("completed", (job) => console.log(`Done: ${job.data.username}`));
worker.on("failed", (job, err) =>
  console.error(`Failed: ${job?.data.username} —`, err.message),
);
worker.on("active", (job) => console.log(`Processing: ${job.data.username}`));

console.log("Worker started, waiting for jobs...");
