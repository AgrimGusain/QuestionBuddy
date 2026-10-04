"use client";

import { Star } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { useSignedUrls } from "@/components/useSignedUrls";
import { inChunks } from "@/lib/fetch-all";
import { compareQuestionNumbers } from "@/lib/number";
import { supabase } from "@/lib/supabase/client";
import type { Attempt, PracticeSession, QuestionOverview } from "@/lib/types";

type Q = Pick<QuestionOverview, "question_id" | "number" | "thumbnail_path" | "is_starred">;

export default function SummaryPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [questions, setQuestions] = useState<Map<string, Q>>(new Map());
  const [starred, setStarred] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const db = supabase();
      const [sr, ar] = await Promise.all([
        db.from("practice_sessions").select("*").eq("id", sessionId).maybeSingle(),
        db.from("attempts").select("*").eq("session_id", sessionId).order("created_at"),
      ]);
      if (sr.error || ar.error) throw new Error((sr.error ?? ar.error)!.message);
      if (!sr.data) throw new Error("This practice session doesn't exist.");
      const s = sr.data as PracticeSession;
      if (!s.ended_at) {
        await db.from("practice_sessions").update({ ended_at: new Date().toISOString() }).eq("id", sessionId).is("ended_at", null);
      }
      const atts = ar.data as Attempt[];
      const qs = await inChunks([...new Set(atts.map((a) => a.question_id))], async (chunk) => {
        const { data, error } = await db
          .from("question_overview")
          .select("question_id, number, thumbnail_path, is_starred")
          .in("question_id", chunk);
        if (error) throw new Error(error.message);
        return data as Q[];
      });
      setSession(s);
      setAttempts(atts);
      setQuestions(new Map(qs.map((q) => [q.question_id, q])));
    })().catch((e) => setError((e as Error).message));
  }, [sessionId]);

  const tally = useMemo(() => {
    const t = { correct: 0, partial: 0, wrong: 0 };
    for (const a of attempts ?? []) t[a.verdict]++;
    return t;
  }, [attempts]);

  const wrong = useMemo(
    () =>
      (attempts ?? [])
        .filter((a) => a.verdict === "wrong")
        .map((a) => questions.get(a.question_id))
        .filter((q): q is Q => !!q)
        .sort((a, b) => compareQuestionNumbers(a.number, b.number)),
    [attempts, questions],
  );
  const thumbs = useSignedUrls("crops", wrong.map((q) => q.thumbnail_path));

  async function starAllWrong() {
    const { error } = await supabase().from("questions").update({ is_starred: true }).in("id", wrong.map((q) => q.question_id));
    if (error) return setError(error.message);
    setStarred(true);
  }

  async function again() {
    if (!session) return;
    const { data, error } = await supabase()
      .from("practice_sessions")
      .insert({ mode: session.mode, filters: session.filters, target_count: session.target_count })
      .select("id")
      .single();
    if (error) return setError(error.message);
    router.push(`/practice/${data.id}`);
  }

  const back = session?.mode === "theory" ? "/theory" : "/practice";
  const total = attempts?.length ?? 0;

  return (
    <>
      <TopBar title="Session summary" back={back} />
      <main className="space-y-6 px-4 py-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!attempts ? (
          !error && <Loading />
        ) : total === 0 ? (
          <p className="text-muted">No questions were answered in this session.</p>
        ) : (
          <>
            <section className="card p-5">
              <p className="text-5xl font-bold">
                {tally.correct}
                <span className="text-2xl text-muted"> / {total}</span>
              </p>
              <p className="mt-1 text-muted">correct</p>
              <div className="mt-4 flex gap-6 text-sm">
                {tally.partial > 0 && <span className="font-bold text-part">{tally.partial} partly right</span>}
                <span className="font-bold text-bad">{tally.wrong} wrong</span>
              </div>
            </section>

            {wrong.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-bold">Got wrong</h2>
                  <button type="button" className="chip" onClick={starAllWrong} disabled={starred} aria-pressed={starred}>
                    <Star size={16} fill={starred ? "currentColor" : "none"} aria-hidden />
                    {starred ? "Starred" : "Star all"}
                  </button>
                </div>
                <ul className="space-y-3">
                  {wrong.map((q) => (
                    <li key={q.question_id}>
                      <Link href={`/library/question/${q.question_id}`} className="card block overflow-hidden">
                        <div className="bg-white">
                          {thumbs[q.thumbnail_path] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={thumbs[q.thumbnail_path]} alt={`Question ${q.number}`} className="max-h-40 w-full object-contain object-top" />
                          ) : (
                            <div className="h-20 animate-pulse bg-sunken" />
                          )}
                        </div>
                        <div className="border-t border-line px-3 py-2">
                          <span className="qnum">{q.number}</span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn-primary" onClick={again} disabled={!session}>
            Practise again
          </button>
          <Link href="/" className="btn-secondary">
            Home
          </Link>
        </div>
      </main>
    </>
  );
}
