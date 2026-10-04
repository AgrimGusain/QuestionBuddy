"use client";

import { useEffect, useState } from "react";
import { signedUrls } from "@/lib/storage";
import type { Bucket } from "@/lib/types";

/** Signed URLs for a list of private Storage paths. */
export function useSignedUrls(bucket: Bucket, paths: string[]): Record<string, string> {
  const key = paths.join("|");
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!key) return;
    let live = true;
    signedUrls(bucket, key.split("|"))
      .then((u) => live && setUrls(u))
      .catch((e) => console.error("signed_urls_failed", e));
    return () => {
      live = false;
    };
  }, [bucket, key]);

  return urls;
}
