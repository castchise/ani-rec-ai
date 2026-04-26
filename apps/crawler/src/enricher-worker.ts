import { Worker } from "bullmq";
import { JikanClient } from "@ani-rec-ai/api-clients";
import { db, anime, eq } from "@ani-rec-ai/db";
import { enrichConnection } from "./enricher-queue";

// One Jikan request every 350 ms ≈ 2.8 req/sec, safely under the 3/sec cap.
// concurrency: 1 means at most one in-flight Jikan call at a time, so the
// JikanClient's internal throttle is the single source of truth for pacing.
const jikan = new JikanClient(350);

const worker = new Worker(
  "anime-enrich",
  async (job) => {
    const { animeId } = job.data as { animeId: number };

    let details: Awaited<ReturnType<typeof jikan.getAnimeDetails>>;
    try {
      details = await jikan.getAnimeDetails(animeId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Jikan returns 404 for IDs that no longer exist on MAL — treat as
      // permanent failure so we don't retry endlessly.
      if (msg.includes("404")) {
        console.warn(`  anime ${animeId}: not found on Jikan (404), skipping`);
        return;
      }
      throw err;
    }

    // Only set fields that Jikan actually returned — never overwrite good data
    // with undefined.  Using a typed partial keeps TS happy with drizzle's
    // update() set argument.
    type AnimeUpdate = Partial<{
      title: string;
      titleEnglish: string | null;
      synopsis: string | null;
      genres: string[];
      studios: string[];
      episodeCount: number | null;
      averageScore: number | null;
      popularity: number | null;
      startDate: string | null;
      status: string | null;
      imageUrl: string | null;
      updatedAt: Date;
    }>;

    const patch: AnimeUpdate = { updatedAt: new Date() };

    if (details.title) patch.title = details.title;
    if ("titleEnglish" in details)
      patch.titleEnglish = details.titleEnglish ?? null;
    if ("synopsis" in details) patch.synopsis = details.synopsis ?? null;
    if (details.genres?.length) patch.genres = details.genres;
    if (details.studios?.length) patch.studios = details.studios;
    if ("episodeCount" in details)
      patch.episodeCount = details.episodeCount ?? null;
    if ("averageScore" in details)
      patch.averageScore = details.averageScore ?? null;
    if ("popularity" in details) patch.popularity = details.popularity ?? null;
    if ("startDate" in details) patch.startDate = details.startDate ?? null;
    if ("status" in details) patch.status = details.status ?? null;
    if ("imageUrl" in details) patch.imageUrl = details.imageUrl ?? null;

    await db.update(anime).set(patch).where(eq(anime.id, animeId));

    console.log(`  Enriched #${animeId}: ${details.title ?? "(unknown)"}`);
  },
  {
    connection: enrichConnection,
    // Single concurrent job — the JikanClient rate-limits per instance, so
    // running more than one job simultaneously would break the rate limit.
    concurrency: 1,
    removeOnComplete: { count: 0 },
    removeOnFail: { count: 200 },
  },
);

worker.on("completed", (job) =>
  console.log(`Done: anime #${job.data.animeId}`),
);
worker.on("failed", (job, err) =>
  console.error(`Failed: anime #${job?.data.animeId} — ${err.message}`),
);
worker.on("active", (job) =>
  console.log(`Enriching: anime #${job.data.animeId}`),
);

console.log("Enricher worker started, waiting for jobs…");
