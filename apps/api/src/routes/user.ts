import { Hono } from "hono";
import { MalClient } from "@ani-rec-ai/api-clients";
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

const malClientId = process.env.MAL_CLIENT_ID;
if (!malClientId) throw new Error("MAL_CLIENT_ID is not set");

const mal = new MalClient(malClientId);

// ---------------------------------------------------------------------------
// POST /users/sync
// Body: { username: string }
//
// Fetches a MAL user's anime list directly from the MAL API, upserts the user
// record and their anime entries. Returns summary info.
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
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.malUsername, malUsername))
    .limit(1);

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

  // Fetch full list from MAL API --------------------------------------------
  // No status filter = all statuses in one paginated sweep.
  let entries: Awaited<ReturnType<typeof mal.getUserAnimeList>>;
  try {
    entries = await mal.getUserAnimeList(malUsername);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("404")) {
      return c.json({ error: `MAL user '${malUsername}' not found` }, 404);
    }
    if (message.startsWith("403")) {
      return c.json({ error: `MAL list for '${malUsername}' is private` }, 403);
    }
    return c.json(
      { error: "Failed to fetch from MAL API", detail: message },
      502,
    );
  }

  // Keep entries that are meaningful for recommendations --------------------
  const relevant = entries.filter(
    (e) =>
      e.status === "completed" || e.status === "watching" || (e.score ?? 0) > 0,
  );

  if (relevant.length > 0) {
    // Upsert minimal anime stubs to satisfy the FK on user_anime_list.
    // Real metadata is filled in later by the enricher worker.
    const animeStubs = relevant.map((e) => ({
      id: e.animeId,
      title: e.animeTitle ?? `Anime #${e.animeId}`,
    }));

    const CHUNK = 500;
    for (let i = 0; i < animeStubs.length; i += CHUNK) {
      await db
        .insert(anime)
        .values(animeStubs.slice(i, i + CHUNK))
        .onConflictDoNothing(); // preserve already-enriched rows
    }

    // Upsert list entries ---------------------------------------------------
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

    for (let i = 0; i < rows.length; i += CHUNK) {
      await db
        .insert(userAnimeList)
        .values(rows.slice(i, i + CHUNK))
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

  // Mark profile as crawled -------------------------------------------------
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
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.malUsername, malUsername))
    .limit(1);

  if (!user) {
    return c.json(
      {
        error: `User '${malUsername}' not found. Call POST /users/sync first.`,
      },
      404,
    );
  }

  // Fetch list entries from DB ----------------------------------------------
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
    // null = not yet enriched by the enricher worker
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
