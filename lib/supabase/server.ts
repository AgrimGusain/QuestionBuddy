import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server Supabase client acting as the signed-in user (cookie session),
 * so RLS and auth.uid() apply exactly as in the browser.
 *
 * Do not swap this for the service-role key without also setting user_id
 * on every insert: auth.uid() is null for the service role.
 */
export async function serverSupabase() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => store.set(name, value, options));
          } catch {
            // Called from a context that can't set cookies; proxy.ts refreshes them.
          }
        },
      },
    },
  );
}
