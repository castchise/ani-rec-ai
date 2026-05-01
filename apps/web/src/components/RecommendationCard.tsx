import Image from "next/image";
import Link from "next/link";
import React from "react";

export default function RecommendationCard({
  imageUrl,
  titleEnglish,
  title,
  genres,
  synopsis,
  animeId,
  averageScore,
  popularity,
  status,
  episodeCount,
}) {
  return (
    <div className="flex bg-white h-75 rounded overflow-hidden shadow border border-slate-100">
      <div className="w-50">
        <Image
          src={imageUrl}
          alt={titleEnglish || title}
          width={250}
          height={250}
          className="w-full h-full"
        />
      </div>

      <div className="px-3 py-4 w-100 flex flex-col items-start">
        <div className="w-full h-full flex gap-x-1 items-start justify-between">
          <div className="h-full flex flex-col items-start text-left">
            <h2 className="font-semibold text-2xl">{title}</h2>
            <h3 className="text-black/50 text-sm">{titleEnglish}</h3>

            <div className="flex gap-x-2">
              {genres.map((genre, id) => (
                <p
                  key={id}
                  className="p-1 mt-3 font-semibold text-xs bg-slate-200 rounded"
                >
                  {genre}
                </p>
              ))}
            </div>

            <p className="mt-3 line-clamp-4 text-left">{synopsis}</p>

            <Link
              href={`https://myanimelist.net/anime/${animeId}`}
              target="_blank"
              className="mt-auto underline text-blue-700"
            >
              Continue on MAL
            </Link>
          </div>

          <div>
            <div className="bg-slate-200 p-4 rounded-sm">
              <h3 className="font-bold text-4xl">{averageScore}</h3>
              <h3 className="text-black/50 text-xs">#{popularity} popular</h3>
            </div>
            <p className="p-1 mt-3 font-semibold text-xs bg-slate-200 rounded">
              {status}
            </p>
            <p className="mt-0.5 text-xs">Episodes: {episodeCount}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
