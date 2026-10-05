/**
 * POST /api/groq/test — checks the server can reach Groq with its key.
 * Signed-in users only, so the endpoint can't be used to probe the key
 * anonymously. Lists models instead of running a completion: no tokens spent.
 */
import { NextResponse } from "next/server";
import { log } from "@/lib/log";
import { serverSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST() {
  const db = await serverSupabase();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  if (!process.env.GROQ_API_KEY) return NextResponse.json({ ok: false, error: "GROQ_API_KEY is not set" });

  const started = Date.now();
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    });
    const latencyMs = Date.now() - started;
    log("groq_test", { status: res.status, latencyMs });
    if (!res.ok) return NextResponse.json({ ok: false, error: `Groq answered HTTP ${res.status}` });
    return NextResponse.json({ ok: true, latencyMs });
  } catch (e) {
    log("groq_test", { error: (e as Error).message });
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
