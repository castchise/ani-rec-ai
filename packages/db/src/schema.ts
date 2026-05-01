import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
  uuid,
  boolean,
  vector,
  customType,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const watchStatusEnum = pgEnum("watch_status", [
  "completed",
  "watching",
  "on_hold",
  "dropped",
  "plan_to_watch",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Core anime catalogue.
 *
 * embedding   — 768-dim Nomic Embed Text v1 vector of (title + synopsis).
 *               Used for content-based similarity search via pgvector.
 * cfVector    — 64-dim latent factor vector produced by matrix factorisation.
 *               Used for collaborative-filtering–based ranking.
 *               Populated by the CF training job (Phase 2+).
 */
export const anime = pgTable(
  "anime",
  {
    id: integer("id").primaryKey(), // MAL/Jikan anime ID
    title: text("title").notNull(),
    titleEnglish: text("title_english"),
    synopsis: text("synopsis"),
    genres: text("genres").array().default([]),
    studios: text("studios").array().default([]),
    episodeCount: integer("episode_count"),
    averageScore: real("average_score"),
    popularity: integer("popularity"),
    startDate: text("start_date"),
    status: text("status"),
    imageUrl: text("image_url"),
    // Embedding vectors — populated by the embed-worker
    embedding: vector("embedding", { dimensions: 768 }),
    cfVector: vector("cf_vector", { dimensions: 64 }),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    popularityIdx: index("anime_popularity_idx").on(t.popularity),
    // HNSW index for fast approximate nearest-neighbour search.
    // Created manually via migration (see drizzle/migrations/0001_pgvector.sql).
    // Drizzle doesn't yet generate HNSW index DDL automatically.
  }),
);

// No malUserId column — Jikan identifies users by username only
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  malUsername: text("mal_username").notNull().unique(),
  listLastSynced: timestamp("list_last_synced"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const userAnimeList = pgTable(
  "user_anime_list",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    animeId: integer("anime_id")
      .notNull()
      .references(() => anime.id, { onDelete: "cascade" }),
    score: integer("score"), // 0 = unscored, 1–10 = rated
    status: watchStatusEnum("status").notNull(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    userAnimeUnique: uniqueIndex("user_anime_unique").on(t.userId, t.animeId),
    userIdIdx: index("ual_user_id_idx").on(t.userId),
    animeIdIdx: index("ual_anime_id_idx").on(t.animeId),
  }),
);

// Crawler tracking — which MAL usernames have been scraped
export const crawledProfiles = pgTable("crawled_profiles", {
  id: serial("id").primaryKey(),
  malUsername: text("mal_username").notNull().unique(),
  crawledAt: timestamp("crawled_at").defaultNow(),
  ratingCount: integer("rating_count").default(0),
  isPrivate: boolean("is_private").default(false),
});
