"use client";

import { Input } from "@/components/ui/input";
import { useState, FormEvent, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Extract a plain MAL username from either a profile URL or a bare username. */
function extractUsername(raw: string): string {
  const trimmed = raw.trim();
  // Handle URLs like https://myanimelist.net/profile/USERNAME
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes("myanimelist.net")) {
      const parts = url.pathname.split("/").filter(Boolean);
      // /profile/username  →  ["profile", "username"]
      const profileIdx = parts.indexOf("profile");
      if (profileIdx !== -1 && parts[profileIdx + 1]) {
        return parts[profileIdx + 1];
      }
      // /animelist/username  →  ["animelist", "username"]
      const listIdx = parts.indexOf("animelist");
      if (listIdx !== -1 && parts[listIdx + 1]) {
        return parts[listIdx + 1];
      }
    }
  } catch {
    // Not a URL — treat as a bare username
  }
  return trimmed;
}

export default function Home() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const username = extractUsername(inputValue);
    if (!username) {
      setError("Please enter a MAL username or profile URL.");
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(`${API_BASE}/users/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });

      if (response.status === 404) {
        setError(`User "${username}" was not found on MyAnimeList.`);
        return;
      }
      if (response.status === 403) {
        setError(`"${username}"'s anime list is set to private.`);
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ??
            "Sync failed. Please try again.",
        );
      }

      // Navigate to recommendations page
      router.push(
        `/recommendations/${encodeURIComponent(username.toLowerCase())}`,
      );
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

  return (
    <main className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-6 overflow-hidden relative">
      {/* Background texture */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
        }}
      />

      {/* Glow orbs */}
      <div
        className="pointer-events-none absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-10"
        style={{
          background: "radial-gradient(circle, #6366f1 0%, transparent 70%)",
        }}
      />
      <div
        className="pointer-events-none absolute bottom-1/4 right-1/4 w-64 h-64 rounded-full opacity-8"
        style={{
          background: "radial-gradient(circle, #ec4899 0%, transparent 70%)",
        }}
      />

      <div className="relative z-10 w-full max-w-lg">
        {/* Badge */}
        <div className="flex justify-center mb-8">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/5 text-white/50 text-xs tracking-widest uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
            AI Powered
          </span>
        </div>

        {/* Headline */}
        <div className="text-center mb-10">
          <h1
            className="text-5xl font-black text-white mb-3 leading-none tracking-tight"
            style={{ fontFamily: "'Georgia', 'Times New Roman', serif" }}
          >
            Ani<span className="text-indigo-400">Rec</span>
          </h1>
          <p className="text-white/40 text-sm tracking-wide leading-relaxed">
            Paste your MyAnimeList profile and discover
            <br />
            anime you&apos;ll actually love.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="relative">
            <Input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setError(null);
              }}
              placeholder="myanimelist.net/profile/username  or  username"
              disabled={isLoading}
              className={[
                "w-full px-4 py-3.5 rounded-xl text-sm",
                "bg-white/[0.06] border text-white placeholder:text-white/25",
                "focus:outline-none focus:ring-2 focus:ring-indigo-500/60",
                "transition-all duration-200",
                error
                  ? "border-red-500/50 focus:ring-red-500/40"
                  : "border-white/10 hover:border-white/20",
                isLoading ? "opacity-50 cursor-not-allowed" : "",
              ].join(" ")}
            />
          </div>

          {error && (
            <p className="text-red-400 text-xs px-1 flex items-start gap-1.5">
              <span className="mt-0.5 shrink-0">⚠</span>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isLoading || !inputValue.trim()}
            className={[
              "relative w-full py-3.5 rounded-xl text-sm font-semibold tracking-wide",
              "bg-indigo-600 text-white",
              "hover:bg-indigo-500 active:scale-[0.99]",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "transition-all duration-150",
              "focus:outline-none focus:ring-2 focus:ring-indigo-500/60 focus:ring-offset-2 focus:ring-offset-[#0a0a0f]",
            ].join(" ")}
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Syncing your list…
              </span>
            ) : (
              "Get Recommendations →"
            )}
          </button>
        </form>

        {/* Footer hint */}
        <p className="text-center text-white/20 text-xs mt-8">
          Your list must be set to public on MAL
        </p>
      </div>
    </main>
  );
}
