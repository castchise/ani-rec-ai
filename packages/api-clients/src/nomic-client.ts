/**
 * NomicClient — wraps Nomic Embed Text v1 (768-dim, free tier).
 *
 * Prefixes:
 *   "search_document: " — for texts stored in the DB (anime synopses)
 *   "search_query: "    — for queries (user taste vector at recommendation time)
 *
 * Free tier rate limits are loose (~1 req/sec effective), but we add a small
 * inter-request delay and automatic 429 back-off just in case.
 */

const NOMIC_BASE = "https://api-atlas.nomic.ai/v1";
const MODEL = "nomic-embed-text-v1";
export const EMBED_DIMS = 768;

/** Max texts Nomic accepts per request. */
const BATCH_SIZE = 96;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface NomicEmbedResponse {
  embeddings: number[][];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export class NomicClient {
  private readonly apiKey: string;
  private lastRequestAt = 0;
  private readonly minInterval: number;

  constructor(apiKey: string, minIntervalMs = 250) {
    if (!apiKey) throw new Error("NOMIC_API_KEY is required");
    this.apiKey = apiKey;
    this.minInterval = minIntervalMs;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async post<T>(path: string, body: unknown): Promise<T> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minInterval) await sleep(this.minInterval - elapsed);
    this.lastRequestAt = Date.now();

    const res = await fetch(`${NOMIC_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 5);
      console.warn(`Nomic 429 — waiting ${retryAfter}s`);
      await sleep(retryAfter * 1_000);
      return this.post<T>(path, body);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Nomic API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Embed an array of texts, automatically chunking into batches.
   * Returns one 768-dim vector per input text in the same order.
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const all: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const data = await this.post<NomicEmbedResponse>("/embedding/text", {
        model: MODEL,
        texts: batch,
      });
      all.push(...data.embeddings);
    }

    return all;
  }

  /**
   * Embed a single anime document (synopsis prefixed for retrieval).
   * buildDocumentText() is exported separately so callers can use it
   * directly when constructing batch arrays.
   */
  async embedDocument(text: string): Promise<number[]> {
    const [vec] = await this.embedTexts([NomicClient.documentText(text)]);
    return vec!;
  }

  /**
   * Embed a free-form query string (e.g. synthesised taste description).
   */
  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embedTexts([NomicClient.queryText(text)]);
    return vec!;
  }

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  /** Wrap text with the "search_document:" prefix Nomic recommends. */
  static documentText(raw: string): string {
    return `search_document: ${raw}`;
  }

  /** Wrap text with the "search_query:" prefix Nomic recommends. */
  static queryText(raw: string): string {
    return `search_query: ${raw}`;
  }

  /**
   * Build a compact document text from an anime record.
   * Title + synopsis provides the richest embedding signal.
   */
  static animeDocument(title: string, synopsis: string | null): string {
    const body = synopsis ? synopsis.slice(0, 1_500) : title;
    return NomicClient.documentText(`${title}. ${body}`);
  }
}
