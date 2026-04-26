/**
 * seed-enricher.ts
 *
 * Pages through the `anime` table looking for rows where `synopsis IS NULL`
 * (the hallmark of a crawler-inserted stub) and enqueues each one as an
 * "anime-enrich" BullMQ job.  Uses `jobId: enrich_<id>` so re-running the
 * script is idempotent — BullMQ will skip IDs that already have a pending or
 * completed job with that ID.
 *
 * Usage:
 *   pnpm exec tsx --env-file=../../.env src/seed-enricher.ts
 *
 * Flags (set as env vars or edit the constants below):
 *   ENRICH_LIMIT   – cap on how many anime to enqueue in one run (0 = all)
 */

import { db, anime, isNull } from "@ani-rec-ai/db";
import { enrichQueue, enrichConnection } from "./enricher-queue";

const BATCH_SIZE = 500;
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT ?? 0); // 0 = unlimited

async function seedEnricher() {
  console.log("Scanning for unenriched anime stubs…");

  let offset = 0;
  let totalQueued = 0;
  let totalSkipped = 0;

  while (true) {
    // Pull a page of stubs that are missing synopsis (the primary signal that
    // the row was inserted by the crawler with minimal fields only).
    const stubs = await db
      .select({ id: anime.id, title: anime.title })
      .from(anime)
      .where(isNull(anime.synopsis))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (stubs.length === 0) break;

    // Build bulk job array — addBulk is a single Redis round-trip.
    const jobs = stubs.map((s) => ({
      name: "anime-enrich",
      data: { animeId: s.id },
      opts: {
        // Stable jobId makes the operation idempotent across re-runs.
        jobId: `enrich_${s.id}`,
        attempts: 3,
        backoff: { type: "exponential" as const, delay: 2_000 },
      },
    }));

    const results = await enrichQueue.addBulk(jobs);

    // addBulk returns null for jobs that were silently deduplicated.
    const added = results.filter(Boolean).length;
    const skipped = results.length - added;

    totalQueued += added;
    totalSkipped += skipped;
    offset += stubs.length;

    console.log(
      `  offset=${offset}  +${added} queued  (${skipped} already in queue)`,
    );

    if (ENRICH_LIMIT > 0 && totalQueued >= ENRICH_LIMIT) {
      console.log(`ENRICH_LIMIT=${ENRICH_LIMIT} reached, stopping early.`);
      break;
    }
  }

  console.log(
    `\nFinished. Queued ${totalQueued} jobs, skipped ${totalSkipped} duplicates.`,
  );

  await enrichQueue.close();
  await enrichConnection.quit();
  process.exit(0);
}

seedEnricher().catch((err) => {
  console.error("seed-enricher failed:", err);
  process.exit(1);
});
