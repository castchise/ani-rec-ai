import { Hono } from "hono";
import { JikanClient } from "@ani-rec-ai/api-clients";
import {
  db,
  users,
  userAnimeList,
  crawledProfiles,
  anime,
  eq,
  and,
  inArray,
  sql,
} from "@ani-rec-ai/db";

export const userRouter = new Hono();

const jikan = new JikanClient();

// ---------------------------------------------------------------------------
// POST /users/sync
// Body: { username: string }
//
// Fetches a MAL user's anime list from Jikan, upserts the user record and
// their anime entries. Returns the canonical user row.
// ---------------------------------------------------------------------------
userRouter.post("/sync", async (c) => {
  let body: { username?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const username = body.username?.trim();
  if (!username) {
    return c.json({ error: "username is required" }, 400);
  }

  // Normalise to lowercase so "Xinil" and "xinil" never produce duplicate rows
  const malUsername = username.toLowerCase();

  // Upsert user row ---------------------------------------------------------
  const existingUser = await db.query.users.findFirst({
    where: (t, { eq }) => eq(t.malUsername, malUsername),
  });

  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    const [inserted] = await db
      .insert(users)
      .values({ malUsername })
      .returning({ id: users.id });
    userId = inserted!.id;
  }

  // Fetch list from Jikan ---------------------------------------------------
  let entries: Awaited<ReturnType<typeof jikan.getUserAnimeList>>;
  try {
    entries = await jikan.getUserAnimeList(malUsername);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404")) {
      return c.json({ error: `MAL user '${malUsername}' not found` }, 404);
    }
    if (message.includes("403")) {
      return c.json({ error: `MAL list for '${malUsername}' is private` }, 403);
    }
    return c.json(
      { error: "Failed to fetch from Jikan", detail: message },
      502,
    );
  }

  // Keep only entries that have a score or are completed/watching -----------
  const relevant = entries.filter(
    (e) =>
      e.status === "completed" || e.status === "watching" || (e.score ?? 0) > 0,
  );

  // Bulk upsert userAnimeList rows ------------------------------------------
  if (relevant.length > 0) {
    const rows = relevant.map((e) => ({
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

  // Mark as crawled ---------------------------------------------------------
  await db
    .insert(crawledProfiles)
    .values({ malUsername, ratingCount: relevant.length })
    .onConflictDoUpdate({
      target: [crawledProfiles.malUsername],
      set: {
        crawledAt: sql`now()`,
        ratingCount: sql`excluded.rating_count`,
      },
    });

  // Stamp last-synced on the user row ---------------------------------------
  await db
    .update(users)
    .set({ listLastSynced: new Date() })
    .where(eq(users.id, userId));

  return c.json({
    userId,
    malUsername,
    syncedEntries: relevant.length,
    message: "Profile synced successfully",
  });
});

// ---------------------------------------------------------------------------
// GET /users/:username/anime
// Query params:
//   status  – watch status filter (default: "completed")
//   scored  – "true" limits to entries with score > 0
//   limit   – max results (default: 100, max: 500)
//   offset  – pagination offset (default: 0)
// ---------------------------------------------------------------------------
userRouter.get("/:username/anime", async (c) => {
  const malUsername = c.req.param("username").toLowerCase();

  const statusParam = c.req.query("status") ?? "completed";
  const scoredOnly = c.req.query("scored") === "true";
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Number(c.req.query("offset") ?? 0);

  const validStatuses = [
    "completed",
    "watching",
    "on_hold",
    "dropped",
    "plan_to_watch",
  ] as const;
  type WatchStatus = (typeof validStatuses)[number];

  if (!validStatuses.includes(statusParam as WatchStatus)) {
    return c.json(
      { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
      400,
    );
  }

  // Resolve user ------------------------------------------------------------
  const user = await db.query.users.findFirst({
    where: (t, { eq }) => eq(t.malUsername, malUsername),
  });

  if (!user) {
    return c.json(
      {
        error: `User '${malUsername}' not found. Call POST /users/sync first.`,
      },
      404,
    );
  }

  // Fetch list entries ------------------------------------------------------
  const listRows = await db
    .select()
    .from(userAnimeList)
    .where(
      and(
        eq(userAnimeList.userId, user.id),
        eq(userAnimeList.status, statusParam as WatchStatus),
      ),
    )
    .limit(limit)
    .offset(offset);

  // Apply scored-only filter (avoids a nullable SQL comparison) -------------
  const filtered = scoredOnly
    ? listRows.filter((r) => (r.score ?? 0) > 0)
    : listRows;

  if (filtered.length === 0) {
    return c.json({
      user: { id: user.id, malUsername },
      entries: [],
      total: 0,
      pagination: { limit, offset },
    });
  }

  // Join with anime metadata where available --------------------------------
  const animeIds = filtered.map((r) => r.animeId);
  const animeRows = await db
    .select()
    .from(anime)
    .where(inArray(anime.id, animeIds));

  const animeMap = new Map(animeRows.map((a) => [a.id, a]));

  const entries = filtered.map((row) => ({
    animeId: row.animeId,
    score: row.score,
    status: row.status,
    updatedAt: row.updatedAt,
    // null = not yet enriched from Jikan (Phase 2)
    anime: animeMap.get(row.animeId) ?? null,
  }));

  return c.json({
    user: {
      id: user.id,
      malUsername: user.malUsername,
      listLastSynced: user.listLastSynced,
    },
    entries,
    total: entries.length,
    pagination: { limit, offset },
  });
});
