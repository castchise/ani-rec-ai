import type { Anime, UserAnimeEntry, WatchStatus } from "@ani-rec-ai/types";

const JIKAN_BASE = "https://api.jikan.moe/v4";
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

interface JikanListResponse {
  data: Array<{
    anime: { mal_id: number; title: string };
    score: number | null;
    watching_status: number;
    updated_at: string;
  }>;
  pagination: {
    has_next_page: boolean;
    current_page: number;
  };
}

interface JikanAnimeResponse {
  data: {
    mal_id: number;
    title: string;
    title_english: string | null;
    synopsis: string | null;
    episodes: number | null;
    score: number | null;
    popularity: number | null;
    status: string;
    aired: { from: string | null };
    genres: Array<{ mal_id: number; name: string }>;
    studios: Array<{ mal_id: number; name: string }>;
    images: { jpg: { image_url: string } };
  };
}

interface JikanFriendsResponse {
  data: Array<{
    user: { username: string };
  }>;
}

type JikanStatus =
  | "completed"
  | "watching"
  | "dropped"
  | "onhold"
  | "plantowatch";

export class JikanClient {
  private lastRequestAt = 0;
  private minInterval: number;

  // minIntervalMs: minimum ms between requests from this instance.
  // Default 350ms ≈ 2.8 req/sec, safely under Jikan's 3/sec hard limit.
  constructor(minIntervalMs = 350) {
    this.minInterval = minIntervalMs;
  }

  private async fetch<T>(path: string): Promise<T> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minInterval) await sleep(this.minInterval - elapsed);
    this.lastRequestAt = Date.now();

    const res = await fetch(`${JIKAN_BASE}${path}`);

    if (res.status === 429) {
      await sleep(1000);
      const retry = await fetch(`${JIKAN_BASE}${path}`);
      if (!retry.ok)
        throw new Error(`Jikan API error: ${retry.status} ${path}`);
      return retry.json() as Promise<T>;
    }

    if (!res.ok) throw new Error(`Jikan API error: ${res.status} ${path}`);
    return res.json() as Promise<T>;
  }

  async getUserAnimeList(
    username: string,
    status?: JikanStatus,
  ): Promise<UserAnimeEntry[]> {
    const entries: UserAnimeEntry[] = [];
    let page = 1;

    while (true) {
      const params = new URLSearchParams({ page: String(page) });
      if (status) params.set("status", status);

      const data = await this.fetch<JikanListResponse>(
        `/users/${username}/animelist?${params}`,
      );

      for (const item of data.data) {
        entries.push({
          animeId: item.anime.mal_id,
          score: item.score ?? null,
          status: mapWatchStatus(item.watching_status),
          updatedAt: item.updated_at,
        });
      }

      if (!data.pagination.has_next_page) break;
      page++;
    }

    return entries;
  }

  async getAnimeDetails(animeId: number): Promise<Partial<Anime>> {
    const data = await this.fetch<JikanAnimeResponse>(`/anime/${animeId}`);
    const a = data.data;

    return {
      id: a.mal_id,
      title: a.title,
      titleEnglish: a.title_english ?? null,
      synopsis: a.synopsis ?? null,
      genres: a.genres?.map((g) => g.name) ?? [],
      studios: a.studios?.map((s) => s.name) ?? [],
      episodeCount: a.episodes ?? null,
      averageScore: a.score ?? null,
      popularity: a.popularity ?? null,
      startDate: a.aired?.from?.split("T")[0] ?? null,
      status: (a.status as Anime["status"]) ?? null,
      imageUrl: a.images?.jpg?.image_url ?? null,
    };
  }

  async getUserFriends(username: string): Promise<string[]> {
    try {
      const data = await this.fetch<JikanFriendsResponse>(
        `/users/${username}/friends?page=1`,
      );
      return data.data.map((f) => f.user.username);
    } catch {
      return [];
    }
  }
}

function mapWatchStatus(code: number): WatchStatus {
  switch (code) {
    case 1:
      return "watching";
    case 2:
      return "completed";
    case 3:
      return "on_hold";
    case 4:
      return "dropped";
    case 6:
      return "plan_to_watch";
    default:
      return "completed";
  }
}
