/**
 * seed-embed.ts
 *
 * Scans the anime table for rows that have a synopsis but no embedding yet,
 * and enqueues them as batched "anime-embed" BullMQ jobs.
 *
 * Using addBulk() makes this a single Redis round-trip per page.
 * Running this script multiple times is safe — BullMQ deduplicates by jobId.
 *
 * Usage:
 *   pnpm exec tsx --env-file=../../.env src/seed-embed.ts
 *
 * Optional env vars:
 *   EMBED_BATCH_SIZE  – anime per job (default: 50, max Nomic accepts: 96)
 *   EMBED_LIMIT       – total anime to enqueue, 0 = all (default: 0)
 */

import { db, anime, isNull, isNotNull } from "@ani-rec-ai/db";
import { sql } from "drizzle-orm";
import { embedQueue, embedConnection } from "./embed-queue";

const PAGE = 1_000; // rows fetched from DB per iteration
const BATCH = Math.min(Number(process.env.EMBED_BATCH_SIZE ?? 50), 96);
const LIMIT = Number(process.env.EMBED_LIMIT ?? 0);

async function main() {
  console.log(
    `seed-embed: batch=${BATCH}, limit=${LIMIT === 0 ? "unlimited" : LIMIT}`,
  );

  let offset = 0;
  let totalQueued = 0;
  let totalSkipped = 0;

  outer: while (true) {
    // Fetch anime that have a synopsis but whose embedding column is NULL
    const rows = await db
      .select({ id: anime.id })
      .from(anime)
      .where(sql`${anime.synopsis} IS NOT NULL AND ${anime.embedding} IS NULL`)
      .limit(PAGE)
      .offset(offset);

    if (rows.length === 0) break;

    // Chunk the page into batches (one BullMQ job per batch)
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH).map((r) => r.id);
      const jobId = `embed_${chunk[0]}_${chunk[chunk.length - 1]}`;

      const results = await embedQueue.addBulk([
        {
          name: "anime-embed",
          data: { animeIds: chunk },
          opts: {
            jobId,
            attempts: 3,
            backoff: { type: "exponential" as const, delay: 3_000 },
          },
        },
      ]);

      const added = results.filter(Boolean).length;
      totalQueued += added;
      totalSkipped += 1 - added; // 0 or 1 per batch job

      if (LIMIT > 0 && totalQueued * BATCH >= LIMIT) {
        console.log(`EMBED_LIMIT=${LIMIT} reached, stopping.`);
        break outer;
      }
    }

    console.log(
      `  offset=${offset + rows.length}  queued=${totalQueued} jobs  skipped=${totalSkipped}`,
    );
    offset += rows.length;
  }

  console.log(
    `\nDone. ${totalQueued} jobs queued (${totalQueued * BATCH} anime max), ${totalSkipped} deduplicated.`,
  );

  await embedQueue.close();
  await embedConnection.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error("seed-embed failed:", err);
  process.exit(1);
});
