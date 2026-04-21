"use client";

import { Input } from "@/components/ui/input";
import { SubmitEvent, useState } from "react";

export default function Home() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();

    setIsLoading(true);
    setError(null);

    try {
      const formData = new FormData(event.currentTarget);
      const response = await fetch("/api/submit", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Failed to submit the data. Please try again.");
      }

      const data = await response.json();
      console.log("response: ", data);
    } catch (error) {
      if (error instanceof Error) setError(error.message);

      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="bg-slate-50 h-screen flex justify-center items-center">
      <div className="w-xl">
        <h1 className="text-lg text-slate-500 font-medium capitalize text-center">
          Ai anime recommendation tool
        </h1>

        <form
          onSubmit={onSubmit}
          className="mt-8 flex flex-col items-center gap-y-4"
        >
          <Input
            type="text"
            className="bg-white shadow-sm w-full p-4"
            placeholder="Paste your MAL profile URL"
          />

          {error && <div style={{ color: "red" }}>{error}</div>}

          <button
            disabled={isLoading}
            className="bg-slate-500 text-slate-50 px-4 py-2 w-full shadow-md hover:bg-slate-600"
          >
            Get Recommendations
          </button>
        </form>
      </div>
    </main>
  );
}
