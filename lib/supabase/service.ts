import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

/**
 * Service-role Supabase client — bypasses Row Level Security entirely.
 * Every query using this client MUST filter by the caller's user_id
 * explicitly (verified via the cookie-scoped serverSupabase() session
 * first); see app/api/pages/[pageId]/segment/route.ts for the required
 * pattern. auth.uid() is null for the service role, so RLS can't help here.
 */
export function serviceSupabase(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set (see .env.example); restart the dev server after adding it.");
  client ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}
