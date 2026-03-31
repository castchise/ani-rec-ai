// packages/types/src/index.ts

export interface Anime {
  id: number; // MAL anime ID (Jikan uses the same IDs)
  title: string;
  titleEnglish: string | null;
  synopsis: string | null;
  genres: string[];
  studios: string[];
  episodeCount: number | null;
  averageScore: number | null; // MAL community score 0–10
  popularity: number | null; // MAL popularity rank
  startDate: string | null; // ISO date
  status: AnimeStatus;
  imageUrl: string | null;
}

export type AnimeStatus =
  | "Finished Airing"
  | "Currently Airing"
  | "Not yet aired";

export type WatchStatus =
  | "completed"
  | "watching"
  | "on_hold"
  | "dropped"
  | "plan_to_watch";

export interface UserAnimeEntry {
  animeId: number;
  score: number | null; // 0 = no score, 1–10 = rated
  status: WatchStatus;
  updatedAt: string;
}

export interface UserProfile {
  id: string; // internal UUID
  malUsername: string;
  listLastSynced: string | null;
}

export interface RecommendationResult {
  anime: Anime;
  score: number; // predicted score 0–10
  reason: "cf" | "embedding" | "hybrid";
  confidence: number; // 0–1
}

export interface RecommendationRequest {
  userId: string;
  limit?: number;
  filters?: RecommendationFilters;
}

export interface RecommendationFilters {
  excludePtw?: boolean;
  excludeWatched?: boolean;
  genres?: string[]; // include only these genres
  excludeGenres?: string[];
  minScore?: number;
  maxEpisodes?: number;
  studios?: string[];
  yearRange?: [number, number];
}
