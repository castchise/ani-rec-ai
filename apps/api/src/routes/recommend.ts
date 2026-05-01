import { Hono } from "hono";
import { getRecommendations } from "../lib/recommend";
import type { RecommendationFilters } from "@ani-rec-ai/types";

export const recommendRouter = new Hono();

// ---------------------------------------------------------------------------
// GET /recommendations/:username
//
// Query params:
//   limit          – max results (default: 20, max: 100)
//   excludeWatched – "false" to include already-watched (default: true)
//   excludePtw     – "true" to exclude plan-to-watch titles (default: false)
//   genres         – comma-separated genre whitelist (e.g. "Action,Romance")
//   excludeGenres  – comma-separated genre blacklist
//   maxEpisodes    – only show anime with ≤ N episodes
//   studios        – comma-separated studio whitelist
// ---------------------------------------------------------------------------
recommendRouter.get("/:username", async (c) => {
  const username = c.req.param("username");

  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);

  const filters: RecommendationFilters = {
    excludeWatched: c.req.query("excludeWatched") !== "false",
    excludePtw: c.req.query("excludePtw") === "true",
  };

  const genres = c.req.query("genres");
  if (genres) filters.genres = genres.split(",").map((g) => g.trim());

  const excludeGenres = c.req.query("excludeGenres");
  if (excludeGenres)
    filters.excludeGenres = excludeGenres.split(",").map((g) => g.trim());

  const maxEpisodes = c.req.query("maxEpisodes");
  if (maxEpisodes) filters.maxEpisodes = Number(maxEpisodes);

  const studios = c.req.query("studios");
  if (studios) filters.studios = studios.split(",").map((s) => s.trim());

  try {
    const result = await getRecommendations(username, {
      limit,
      filters,
      nomicApiKey: process.env.NOMIC_API_KEY,
    });

    return c.json(result);
  } catch (err) {
    const e = err as { message: string; status?: number };
    const status = e.status ?? 500;
    return c.json({ error: e.message }, status as 404 | 500);
  }
});
