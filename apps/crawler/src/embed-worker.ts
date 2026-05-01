/**
 * embed-worker.ts
 *
 * Processes "anime-embed" jobs from the BullMQ queue.
 *
 * Each job carries:
 *   animeIds: number[]   — batch of anime IDs to embed in one Nomic request
 *
 * The worker fetches synopsis + title from DB, builds Nomic document texts,
 * calls the embedding API (one request per job regardless of batch size),
 * and writes the resulting vectors back into anime.embedding.
 *
 * Usage:
 *   pnpm exec tsx --env-file=../../.env src/embed-worker.ts
 */

import { Worker } from "bullmq";
import { NomicClient } from "@ani-rec-ai/api-clients";
import { db, anime, inArray, sql } from "@ani-rec-ai/db";
import { embedConnection } from "./embed-queue";

const nomicApiKey = process.env.NOMIC_API_KEY;
if (!nomicApiKey) throw new Error("NOMIC_API_KEY is not set");

const nomic = new NomicClient(nomicApiKey);

const worker = new Worker(
  "anime-embed",
  async (job) => {
    const { animeIds } = job.data as { animeIds: number[] };

    if (!animeIds?.length) return;

    // -------------------------------------------------------------------------
    // 1. Fetch anime rows we need to embed
    // -------------------------------------------------------------------------
    const rows = await db
      .select({
        id: anime.id,
        title: anime.title,
        synopsis: anime.synopsis,
      })
      .from(anime)
      .where(inArray(anime.id, animeIds));

    if (rows.length === 0) {
      console.log(
        `  embed-worker: no rows found for ids ${animeIds.join(",")}`,
      );
      return;
    }

    // -------------------------------------------------------------------------
    // 2. Build document texts and call Nomic
    // -------------------------------------------------------------------------
    const texts = rows.map((r) =>
      NomicClient.animeDocument(r.title, r.synopsis),
    );

    console.log(`  Embedding ${texts.length} anime via Nomic…`);
    const embeddings = await nomic.embedTexts(texts);

    // -------------------------------------------------------------------------
    // 3. Write vectors back to DB
    // -------------------------------------------------------------------------
    // We update row-by-row so a single failure doesn't lose the whole batch.
    // For the typical batch of 50 this is fast enough; pgvector writes are cheap.
    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const vec = embeddings[i];
      if (!vec || vec.length === 0) continue;

      // Format as Postgres vector literal: '[0.1,0.2,...]'
      const vectorLiteral = `[${vec.join(",")}]`;

      await db
        .update(anime)
        .set({
          embedding: sql`${vectorLiteral}::vector`,
          updatedAt: new Date(),
        })
        .where(sql`${anime.id} = ${row.id}`);

      updated++;
    }

    console.log(`  Embedded ${updated}/${rows.length} anime (job ${job.id})`);
  },
  {
    connection: embedConnection,
    // Keep concurrency=1 to avoid saturating Nomic free tier.
    // Each job already carries a batch, so throughput is still good.
    concurrency: 1,
    removeOnComplete: { count: 0 },
    removeOnFail: { count: 200 },
  },
);

worker.on("completed", (job) =>
  console.log(
    `Done: embed job ${job.id} (${(job.data.animeIds as number[]).length} anime)`,
  ),
);
worker.on("failed", (job, err) =>
  console.error(`Failed: embed job ${job?.id} — ${err.message}`),
);

console.log("Embed worker started, waiting for jobs…");
