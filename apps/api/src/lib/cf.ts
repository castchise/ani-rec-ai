/**
 * cf.ts — Memory-based user-user collaborative filtering.
 *
 * Algorithm:
 *   1. Load the target user's rated anime (normalised to 0-1).
 *   2. Find candidate users who share ≥ MIN_OVERLAP rated anime with the target.
 *   3. Compute cosine similarity between each candidate and the target.
 *   4. For every unrated anime, predict: Σ(sim_i * score_i) / Σ(|sim_i|)
 *      (weighted average of similar users' scores).
 *   5. Return a Map<animeId, predictedScore> in [0,1] range.
 *
 * Practical limits keep this fast without a dedicated ML service:
 *   MAX_CANDIDATE_USERS = 300  — cap the neighbourhood search
 *   K_NEAREST            = 50  — use only the top-K neighbours per prediction
 *   MIN_OVERLAP          = 3   — ignore users with < 3 shared titles
 *   MIN_SIMILARITY       = 0.1 — ignore weakly correlated users
 */

import { db, userAnimeList, sql, inArray, and, gt, ne } from "@ani-rec-ai/db";

const MAX_CANDIDATE_USERS = 300;
const K_NEAREST = 50;
const MIN_OVERLAP = 3;
const MIN_SIMILARITY = 0.1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two sparse rating maps.
 * Only overlapping anime ids contribute to the dot product — this naturally
 * biases towards users who have rated more of the same titles.
 */
function cosineSim(a: Map<number, number>, b: Map<number, number>): number {
  let dot = 0;
  let magA = 0;

  for (const [id, sa] of a) {
    magA += sa * sa;
    const sb = b.get(id);
    if (sb !== undefined) dot += sa * sb;
  }

  let magB = 0;
  for (const sb of b.values()) magB += sb * sb;

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

/** Build a normalised (0-1) rating map from DB rows. */
function buildRatingMap(
  rows: { animeId: number; score: number | null }[],
): Map<number, number> {
  const map = new Map<number, number>();
  for (const r of rows) {
    if ((r.score ?? 0) > 0) {
      map.set(r.animeId, (r.score ?? 0) / 10);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute collaborative-filtering predicted scores for a set of candidate anime.
 *
 * @param targetUserId   UUID of the user requesting recommendations.
 * @param targetRatings  Their rated anime as a normalised Map (id → 0-1 score).
 * @param candidateIds   Anime IDs to score (typically the pgvector top-200 results).
 * @returns              Map<animeId, predictedScore> — only contains IDs for which
 *                       at least one similar user has a rating.
 */
export async function getCFScores(
  targetUserId: string,
  targetRatings: Map<number, number>,
  candidateIds: number[],
): Promise<Map<number, number>> {
  if (targetRatings.size === 0 || candidateIds.length === 0) {
    return new Map();
  }

  const targetAnimeIds = [...targetRatings.keys()];

  // -------------------------------------------------------------------------
  // Step 1: Find candidate users who overlap with the target user's list.
  // We use raw SQL here because drizzle's GROUP BY + HAVING isn't yet fully
  // typed in the v1 beta.
  // -------------------------------------------------------------------------
  const candidateResult = await db.execute<{ userId: string }>(sql`
    SELECT user_id AS "userId"
    FROM user_anime_list
    WHERE anime_id = ANY(ARRAY[${sql.raw(targetAnimeIds.join(","))}]::int[])
      AND user_id != ${targetUserId}::uuid
      AND score > 0
    GROUP BY user_id
    HAVING COUNT(*) >= ${MIN_OVERLAP}
    ORDER BY COUNT(*) DESC
    LIMIT ${MAX_CANDIDATE_USERS}
  `);

  const candidateUserIds = candidateResult.map((r) => r.userId);
  if (candidateUserIds.length === 0) return new Map();

  // -------------------------------------------------------------------------
  // Step 2: Load ratings for candidate users.
  // We need their ratings on BOTH the shared titles (for similarity) AND the
  // candidate anime (for prediction), so we pull everything and filter in JS.
  // -------------------------------------------------------------------------
  const allNeeded = Array.from(new Set([...targetAnimeIds, ...candidateIds]));

  const ratingRows = await db
    .select({
      userId: userAnimeList.userId,
      animeId: userAnimeList.animeId,
      score: userAnimeList.score,
    })
    .from(userAnimeList)
    .where(
      sql`${userAnimeList.userId} = ANY(ARRAY[${sql.raw(
        candidateUserIds.map((id) => `'${id}'`).join(","),
      )}]::uuid[])
        AND ${userAnimeList.animeId} = ANY(ARRAY[${sql.raw(allNeeded.join(","))}]::int[])
        AND ${userAnimeList.score} > 0`,
    );

  // -------------------------------------------------------------------------
  // Step 3: Build per-user rating maps & compute similarity.
  // -------------------------------------------------------------------------
  const userMaps = new Map<string, Map<number, number>>();
  for (const row of ratingRows) {
    if (!userMaps.has(row.userId)) userMaps.set(row.userId, new Map());
    userMaps.get(row.userId)!.set(row.animeId, (row.score ?? 0) / 10);
  }

  const neighbours: Array<{
    sim: number;
    ratings: Map<number, number>;
  }> = [];

  for (const [, ratings] of userMaps) {
    const sim = cosineSim(targetRatings, ratings);
    if (sim >= MIN_SIMILARITY) {
      neighbours.push({ sim, ratings });
    }
  }

  // Keep only the K-nearest neighbours
  neighbours.sort((a, b) => b.sim - a.sim);
  const topK = neighbours.slice(0, K_NEAREST);

  // -------------------------------------------------------------------------
  // Step 4: Predict scores for candidate anime.
  // -------------------------------------------------------------------------
  const predictions = new Map<number, number>();

  for (const animeId of candidateIds) {
    if (targetRatings.has(animeId)) continue; // already rated — skip

    let weightedSum = 0;
    let totalWeight = 0;

    for (const { sim, ratings } of topK) {
      const s = ratings.get(animeId);
      if (s !== undefined) {
        weightedSum += sim * s;
        totalWeight += sim;
      }
    }

    if (totalWeight > 0) {
      predictions.set(animeId, weightedSum / totalWeight);
    }
  }

  return predictions;
}

/**
 * Build a normalised rating map for the given user from DB.
 * Exported so the recommendation route doesn't need to re-query.
 */
export async function loadUserRatings(
  userId: string,
): Promise<Map<number, number>> {
  const rows = await db
    .select({ animeId: userAnimeList.animeId, score: userAnimeList.score })
    .from(userAnimeList)
    .where(
      sql`${userAnimeList.userId} = ${userId}::uuid AND ${userAnimeList.score} > 0`,
    );

  return buildRatingMap(rows);
}
