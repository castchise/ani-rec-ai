"use client";

import RecommendationCard from "@/components/RecommendationCard";
import { use, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const RECOMMENDATIONS_LIMIT = "100";
export interface RecommendationEntry {
  animeId: number;
  title: string;
  titleEnglish: string | null;
  synopsis: string | null;
  genres: string[];
  studios: string[];
  episodeCount: number | null;
  averageScore: number | null;
  popularity: number | null;
  startDate: string | null;
  status: string | null;
  imageUrl: string | null;
  scores: {
    embedding: number; // cosine similarity (0-1)
    cf: number; // CF predicted score normalised (0-1)
    final: number; // blended score used for ranking
  };
}
interface RecommendResult {
  userId: string;
  malUsername: string;
  recommendations: RecommendationEntry[];
  meta: {
    ratedCount: number;
    embeddingsAvailable: number;
    cfNeighboursFound: boolean;
    strategy: "hybrid" | "embedding_only" | "popularity_fallback";
  };
}

interface Props {
  params: Promise<{ username: string }>;
}

export default function RecommendationsPage({ params }: Props) {
  const { username } = use(params);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [animeRecommendations, setAnimeRecommendations] = useState<
    RecommendationEntry[]
  >([]);

  useEffect(() => {
    async function loadRecommendations() {
      try {
        const queryParams = new URLSearchParams({
          limit: RECOMMENDATIONS_LIMIT,
          excludeWatched: "false",
          excludePtw: "false",
        });

        const response = await fetch(
          `${API_BASE}/recommendations/${username}?${queryParams}`,
          {
            method: "GET",
            headers: { "Content-Type": "application/json" },
          },
        );

        if (response.status === 404) {
          setError(`Couldn't find recommendations for ${username}`);
          return;
        }

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(
            (data as { error?: string }).error ??
              "Failed to retrieve recommendations. Please try again.",
          );
        }

        const { recommendations } = await response.json();
        setAnimeRecommendations(recommendations);
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError("Something went wrong. Please try again.");
        }
      } finally {
        setIsLoading(false);
      }
    }

    loadRecommendations();
    // eslint-disable-next-line
  }, []);

  return (
    <main className="min-h-screen  flex items-center justify-center p-6">
      {isLoading ? (
        <h1 className="text-white text-2xl font-bold">
          Getting recommendations...
        </h1>
      ) : (
        <div className="text-center">
          <p className="text-black/50 text-sm mb-2">Recommendations for</p>
          <h1 className="text-black text-2xl font-bold">
            {decodeURIComponent(username)}
          </h1>

          {error && (
            <p className="text-red-400 text-xs px-1 flex items-start gap-1.5">
              <span className="mt-0.5 shrink-0">⚠</span>
              {error}
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-5">
            {animeRecommendations.map((animeRecommendation) => (
              <RecommendationCard
                key={animeRecommendation.animeId}
                {...animeRecommendation}
              />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
