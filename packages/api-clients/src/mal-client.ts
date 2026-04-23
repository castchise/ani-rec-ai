import type { UserAnimeEntry, WatchStatus } from "@ani-rec-ai/types";

const MAL_BASE = "https://api.myanimelist.net/v2";
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

type MalStatus =
  | "watching"
  | "completed"
  | "on_hold"
  | "dropped"
  | "plan_to_watch";

interface MalAnimeListResponse {
  data: Array<{
    node: { id: number; title: string };
    list_status: {
      status: MalStatus;
      score: number; // 0 = unscored, 1-10 = rated
      num_episodes_watched: number;
      updated_at: string; // ISO 8601
    };
  }>;
  paging: {
    next?: string;
  };
}

export class MalClient {
  private clientId: string;
  private lastRequestAt = 0;
  private minInterval: number;

  // MAL API allows ~5 req/sec — 250ms interval keeps us safely under
  constructor(clientId: string, minIntervalMs = 250) {
    if (!clientId) throw new Error("MAL_CLIENT_ID is required");
    this.clientId = clientId;
    this.minInterval = minIntervalMs;
  }

  private async fetch<T>(url: string): Promise<T> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minInterval) await sleep(this.minInterval - elapsed);
    this.lastRequestAt = Date.now();

    const res = await fetch(url, {
      headers: {
        "X-MAL-CLIENT-ID": this.clientId,
        Accept: "application/json",
      },
    });

    if (res.status === 403) throw new Error(`403 list is private`);
    if (res.status === 404) throw new Error(`404 user not found`);
    if (res.status === 429) {
      await sleep(2000);
      return this.fetch<T>(url); // retry once
    }
    if (!res.ok) throw new Error(`MAL API error: ${res.status} ${url}`);

    return res.json() as Promise<T>;
  }

  // Fetches a user's anime list for a given status, paginating automatically.
  // MAL API returns max 1000 per page; we follow paging.next until exhausted.
  async getUserAnimeList(
    username: string,
    status?: MalStatus,
  ): Promise<UserAnimeEntry[]> {
    const entries: UserAnimeEntry[] = [];

    const params = new URLSearchParams({
      fields: "list_status",
      limit: "1000",
      ...(status ? { status } : {}),
    });

    let nextUrl: string | undefined =
      `${MAL_BASE}/users/${username}/animelist?${params}`;

    while (nextUrl) {
      const data: MalAnimeListResponse =
        await this.fetch<MalAnimeListResponse>(nextUrl);

      for (const item of data.data) {
        entries.push({
          animeId: item.node.id,
          animeTitle: item.node.title,
          score: item.list_status.score || null, // 0 = unscored → null
          status: item.list_status.status as WatchStatus,
          updatedAt: item.list_status.updated_at,
        });
      }

      nextUrl = data.paging?.next;
    }

    return entries;
  }
}
