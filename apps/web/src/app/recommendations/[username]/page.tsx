"use client";

import { use } from "react";

interface Props {
  params: Promise<{ username: string }>;
}

export default function RecommendationsPage({ params }: Props) {
  const { username } = use(params);

  return (
    <main className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-6">
      <div className="text-center">
        <p className="text-white/50 text-sm mb-2">Recommendations for</p>
        <h1 className="text-white text-2xl font-bold">
          {decodeURIComponent(username)}
        </h1>
        <p className="text-white/30 text-sm mt-4">Coming next…</p>
      </div>
    </main>
  );
}
