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
  // vector,
} from "drizzle-orm/pg-core";

export const watchStatusEnum = pgEnum("watch_status", [
  "completed",
  "watching",
  "on_hold",
  "dropped",
  "plan_to_watch",
]);

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
    // Embedding vectors — populated in Phase 2
    // embedding: vector("embedding", { dimensions: 1536 }),
    // cfVector: vector("cf_vector", { dimensions: 100 }),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    popularityIdx: index("anime_popularity_idx").on(t.popularity),
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
