"use client";

import { useSignedUrls } from "@/components/useSignedUrls";

/** A worked-solution crop from an answer key (bucket "crops"). */
export function SolutionImage({ path, number }: { path: string; number: string }) {
  const urls = useSignedUrls("crops", [path]);
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-bold text-muted">Worked solution</h3>
      {urls[path] ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={urls[path]} alt={`Worked solution for question ${number}`} className="block w-full rounded-lg border border-line bg-white" />
      ) : (
        <div className="h-40 animate-pulse rounded-lg bg-sunken" />
      )}
    </div>
  );
}
