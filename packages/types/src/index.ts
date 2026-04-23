// packages/types/src/index.ts

export interface Anime {
  id: number; // MAL anime ID
  title: string;
  titleEnglish: string | null;
  synopsis: string | null;
  genres: string[];
  studios: string[];
  episodeCount: number | null;
  averageScore: number | null;
  popularity: number | null;
  startDate: string | null;
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
  animeTitle?: string | null; // populated by MalClient; used to upsert anime stubs
  score: number | null; // 0 = no score, 1–10 = rated
  status: WatchStatus;
  updatedAt: string;
}

export interface UserProfile {
  id: string;
  malUsername: string;
  listLastSynced: string | null;
}

export interface RecommendationResult {
  anime: Anime;
  score: number;
  reason: "cf" | "embedding" | "hybrid";
  confidence: number;
}

export interface RecommendationRequest {
  userId: string;
  limit?: number;
  filters?: RecommendationFilters;
}

export interface RecommendationFilters {
  excludePtw?: boolean;
  excludeWatched?: boolean;
  genres?: string[];
  excludeGenres?: string[];
  minScore?: number;
  maxEpisodes?: number;
  studios?: string[];
  yearRange?: [number, number];
}
