import { supabase } from "./supabase/client";
import type { Bucket } from "./types";

const TTL_SECONDS = 60 * 60;
const cache = new Map<string, { url: string; expiresAt: number }>();

/** Signed URLs for private objects, cached until a minute before expiry. */
export async function signedUrls(bucket: Bucket, paths: string[]): Promise<Record<string, string>> {
  const now = Date.now();
  const key = (p: string) => `${bucket}:${p}`;
  const missing = [...new Set(paths)].filter((p) => (cache.get(key(p))?.expiresAt ?? 0) < now + 60_000);

  if (missing.length) {
    const { data, error } = await supabase().storage.from(bucket).createSignedUrls(missing, TTL_SECONDS);
    if (error) throw error;
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) {
        cache.set(key(item.path), { url: item.signedUrl, expiresAt: now + TTL_SECONDS * 1000 });
      }
    }
  }

  const out: Record<string, string> = {};
  for (const p of paths) {
    const hit = cache.get(key(p));
    if (hit) out[p] = hit.url;
  }
  return out;
}

/** Remove objects in chunks; failures are logged, not thrown (rows are already gone). */
export async function removeObjects(bucket: Bucket, paths: string[]): Promise<void> {
  const unique = [...new Set(paths)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 100) {
    const { error } = await supabase().storage.from(bucket).remove(unique.slice(i, i + 100));
    if (error) console.error("storage_remove_failed", { bucket, error: error.message });
  }
}
