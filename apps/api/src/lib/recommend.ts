/**
 * recommend.ts — Hybrid recommendation pipeline.
 *
 * Pipeline for a single user request:
 *
 *   1. Load the user's scored anime from DB.
 *   2. Compute a "taste vector" — weighted average of embeddings for their
 *      top-rated anime, score-weighted. Falls back gracefully when embeddings
 *      aren't available yet.
 *   3. Run a pgvector cosine ANN search to retrieve 200 candidates.
 *   4. Apply hard filters (exclude already-watched, PTW, hated genres, etc.).
 *   5. Re-rank candidates with CF predicted scores.
 *   6. Blend: final = α * embedding_score + (1-α) * cf_score.
 *   7. Return top N.
 */

import {
  db,
  anime,
  users,
  userAnimeList,
  sql,
  eq,
  inArray,
} from "@ani-rec-ai/db";
import { NomicClient } from "@ani-rec-ai/api-clients";
import type { RecommendationFilters } from "@ani-rec-ai/types";
import { getCFScores, loadUserRatings } from "./cf";

// Weight given to embedding similarity vs CF score in the final blend.
const EMBEDDING_WEIGHT = 0.4;
const CF_WEIGHT = 0.6;

// Number of pgvector ANN candidates to fetch before filtering/re-ranking.
const ANN_CANDIDATES = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecommendationEntry {
  animeId: number;
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
  scores: {
    embedding: number; // cosine similarity (0-1)
    cf: number; // CF predicted score normalised (0-1)
    final: number; // blended score used for ranking
  };
}

export interface RecommendResult {
  userId: string;
  malUsername: string;
  recommendations: RecommendationEntry[];
  meta: {
    ratedCount: number;
    embeddingsAvailable: number;
    cfNeighboursFound: boolean;
    strategy: "hybrid" | "embedding_only" | "popularity_fallback";
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Element-wise weighted sum of multiple vectors. */
function weightedAverageVectors(
  pairs: Array<{ vec: number[]; weight: number }>,
): number[] | null {
  if (pairs.length === 0) return null;

  const dims = pairs[0]!.vec.length;
  const out = new Array<number>(dims).fill(0);
  let totalWeight = 0;

  for (const { vec, weight } of pairs) {
    for (let i = 0; i < dims; i++) out[i]! += vec[i]! * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  for (let i = 0; i < dims; i++) out[i]! /= totalWeight;

  // L2-normalise so cosine similarity = dot product
  const mag = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
  return mag > 0 ? out.map((v) => v / mag) : out;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function getRecommendations(
  malUsername: string,
  options: {
    limit?: number;
    filters?: RecommendationFilters;
    nomicApiKey?: string;
  } = {},
): Promise<RecommendResult> {
  const { limit = 20, filters = {}, nomicApiKey } = options;

  // -------------------------------------------------------------------------
  // 1. Resolve user
  // -------------------------------------------------------------------------
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.malUsername, malUsername.toLowerCase()))
    .limit(1);

  if (!user) {
    throw Object.assign(new Error(`User '${malUsername}' not found`), {
      status: 404,
    });
  }

  // -------------------------------------------------------------------------
  // 2. Load rated anime for the user
  // -------------------------------------------------------------------------
  const listRows = await db
    .select({
      animeId: userAnimeList.animeId,
      score: userAnimeList.score,
      status: userAnimeList.status,
    })
    .from(userAnimeList)
    .where(eq(userAnimeList.userId, user.id));

  const ratedIds = new Set(listRows.map((r) => r.animeId));
  const ptwIds = new Set(
    listRows.filter((r) => r.status === "plan_to_watch").map((r) => r.animeId),
  );

  // Build normalised rating map (used for CF)
  const userRatings = new Map<number, number>();
  for (const r of listRows) {
    if ((r.score ?? 0) > 0) userRatings.set(r.animeId, (r.score ?? 0) / 10);
  }

  // Top-rated anime for taste vector (score >= 7, sorted desc)
  const topRated = listRows
    .filter((r) => (r.score ?? 0) >= 7)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 50);

  // -------------------------------------------------------------------------
  // 3. Load embeddings for top-rated anime & compute taste vector
  // -------------------------------------------------------------------------
  let tasteVector: number[] | null = null;
  let embeddingsAvailable = 0;

  if (topRated.length > 0) {
    const topIds = topRated.map((r) => r.animeId);
    const embRows = await db
      .select({
        id: anime.id,
        embedding: anime.embedding,
        score: userAnimeList.score,
      })
      .from(anime)
      .innerJoin(userAnimeList, eq(userAnimeList.animeId, anime.id))
      .where(
        sql`${anime.id} = ANY(ARRAY[${sql.raw(topIds.join(","))}]::int[])
          AND ${userAnimeList.userId} = ${user.id}::uuid
          AND ${anime.embedding} IS NOT NULL`,
      );

    embeddingsAvailable = embRows.length;

    const pairs = embRows
      .filter((r) => r.embedding !== null)
      .map((r) => ({
        vec: r.embedding as unknown as number[],
        weight: (r.score ?? 5) / 10,
      }));

    tasteVector = weightedAverageVectors(pairs);
  }

  // -------------------------------------------------------------------------
  // 4. pgvector ANN search — fetch candidate anime
  // -------------------------------------------------------------------------
  let strategy: RecommendResult["meta"]["strategy"] = "popularity_fallback";
  let candidateRows: Array<{
    id: number;
    title: string;
    titleEnglish: string | null;
    synopsis: string | null;
    genres: string[] | null;
    studios: string[] | null;
    episodeCount: number | null;
    averageScore: number | null;
    popularity: number | null;
    startDate: string | null;
    status: string | null;
    imageUrl: string | null;
    embScore: number;
  }> = [];

  if (tasteVector !== null) {
    strategy = "embedding_only";
    const vectorLiteral = `[${(tasteVector as number[]).join(",")}]`;

    // Exclude already-rated anime at query time for efficiency
    const excludeIds =
      ratedIds.size > 0 ? `AND id NOT IN (${[...ratedIds].join(",")})` : "";

    const result = await db.execute<{
      id: number;
      title: string;
      title_english: string | null;
      synopsis: string | null;
      genres: string[] | null;
      studios: string[] | null;
      episode_count: number | null;
      average_score: number | null;
      popularity: number | null;
      start_date: string | null;
      status: string | null;
      image_url: string | null;
      emb_score: number;
    }>(sql`
      SELECT
        id, title, title_english, synopsis, genres, studios,
        episode_count, average_score, popularity, start_date, status, image_url,
        1 - (embedding <=> ${vectorLiteral}::vector) AS emb_score
      FROM anime
      WHERE embedding IS NOT NULL
        ${sql.raw(excludeIds)}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${ANN_CANDIDATES}
    `);

    candidateRows = result.map((r) => ({
      id: r.id,
      title: r.title,
      titleEnglish: r.title_english,
      synopsis: r.synopsis,
      genres: r.genres ?? [],
      studios: r.studios ?? [],
      episodeCount: r.episode_count,
      averageScore: r.average_score,
      popularity: r.popularity,
      startDate: r.start_date,
      status: r.status,
      imageUrl: r.image_url,
      embScore: r.emb_score,
    }));
  }

  // Fallback: popularity-ranked anime if embeddings are not available yet
  if (candidateRows.length < 20) {
    const excludeIds =
      ratedIds.size > 0
        ? sql`AND ${anime.id} NOT IN (${sql.raw([...ratedIds].join(","))})`
        : sql``;

    const fallback = await db
      .select()
      .from(anime)
      .where(sql`${anime.popularity} IS NOT NULL ${excludeIds}`)
      .orderBy(sql`${anime.popularity} ASC`) // lower popularity rank = more popular on MAL
      .limit(ANN_CANDIDATES);

    const existing = new Set(candidateRows.map((r) => r.id));
    for (const r of fallback) {
      if (!existing.has(r.id)) {
        candidateRows.push({
          ...r,
          genres: r.genres ?? [],
          studios: r.studios ?? [],
          embScore: 0,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Apply hard filters
  // -------------------------------------------------------------------------
  let filtered = candidateRows;

  if (filters.excludeWatched !== false) {
    filtered = filtered.filter((r) => !ratedIds.has(r.id));
  }
  if (filters.excludePtw) {
    filtered = filtered.filter((r) => !ptwIds.has(r.id));
  }
  if (filters.genres?.length) {
    const wanted = new Set(filters.genres.map((g) => g.toLowerCase()));
    filtered = filtered.filter((r) =>
      (r.genres ?? []).some((g) => wanted.has(g.toLowerCase())),
    );
  }
  if (filters.excludeGenres?.length) {
    const banned = new Set(filters.excludeGenres.map((g) => g.toLowerCase()));
    filtered = filtered.filter(
      (r) => !(r.genres ?? []).some((g) => banned.has(g.toLowerCase())),
    );
  }
  if (filters.maxEpisodes) {
    filtered = filtered.filter(
      (r) => r.episodeCount === null || r.episodeCount <= filters.maxEpisodes!,
    );
  }
  if (filters.studios?.length) {
    const wanted = new Set(filters.studios.map((s) => s.toLowerCase()));
    filtered = filtered.filter((r) =>
      (r.studios ?? []).some((s) => wanted.has(s.toLowerCase())),
    );
  }

  // -------------------------------------------------------------------------
  // 6. Collaborative filtering re-ranking
  // -------------------------------------------------------------------------
  const candidateIds = filtered.map((r) => r.id);
  const cfScores = await getCFScores(user.id, userRatings, candidateIds);
  const cfNeighboursFound = cfScores.size > 0;

  if (cfNeighboursFound) {
    strategy = "hybrid";
  }

  // -------------------------------------------------------------------------
  // 7. Blend scores and rank
  // -------------------------------------------------------------------------
  const ranked = filtered.map((r) => {
    const embScore = r.embScore;
    const cfScore = cfScores.get(r.id) ?? 0;

    // If we have both signals, blend. If only embedding, use that.
    // If neither (popularity fallback), use a small constant to keep ordering stable.
    let final: number;
    if (cfNeighboursFound) {
      final = EMBEDDING_WEIGHT * embScore + CF_WEIGHT * cfScore;
    } else if (embScore > 0) {
      final = embScore;
    } else {
      // Popularity fallback: normalise inverse rank to [0, 0.5]
      const pop = r.popularity ?? 9999;
      final = Math.max(0, 0.5 - pop / 20_000);
    }

    return {
      animeId: r.id,
      title: r.title,
      titleEnglish: r.titleEnglish,
      synopsis: r.synopsis,
      genres: r.genres ?? [],
      studios: r.studios ?? [],
      episodeCount: r.episodeCount,
      averageScore: r.averageScore,
      popularity: r.popularity,
      startDate: r.startDate,
      status: r.status,
      imageUrl: r.imageUrl,
      scores: {
        embedding: Math.round(embScore * 1_000) / 1_000,
        cf: Math.round(cfScore * 1_000) / 1_000,
        final: Math.round(final * 1_000) / 1_000,
      },
    } satisfies RecommendationEntry;
  });

  ranked.sort((a, b) => b.scores.final - a.scores.final);

  return {
    userId: user.id,
    malUsername: user.malUsername,
    recommendations: ranked.slice(0, limit),
    meta: {
      ratedCount: listRows.length,
      embeddingsAvailable,
      cfNeighboursFound,
      strategy,
    },
  };
}
