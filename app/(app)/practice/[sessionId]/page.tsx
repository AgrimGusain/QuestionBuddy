"use client";

import { Eye, Star } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { OptionPad } from "@/components/OptionPad";
import { ShareButtons } from "@/components/ShareButtons";
import { SolutionImage } from "@/components/SolutionImage";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { canAutoGrade, formatAnswer, gradeMcq, gradeMsq, gradeNumeric, numericRange, parseUserNumber } from "@/lib/grading";
import { loadHierarchy, pathLabel, type Hierarchy } from "@/lib/hierarchy";
import { findCandidates, shuffle } from "@/lib/practice";
import { signedUrls } from "@/lib/storage";
import { supabase } from "@/lib/supabase/client";
import type { Answer, Attempt, PracticeSession, Question, Verdict } from "@/lib/types";

interface Current {
  q: Question;
  answer: Answer | null;
  urls: string[];
}

const VERDICT_TEXT: Record<Verdict, string> = { correct: "Correct", partial: "Partly right", wrong: "Wrong" };
const VERDICT_TONE: Record<Verdict, string> = {
  correct: "border-ok bg-ok/10 text-ok",
  partial: "border-part bg-part/10 text-part",
  wrong: "border-bad bg-bad/10 text-bad",
};

export default function PracticeSessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [h, setH] = useState<Hierarchy | null>(null);
  const [remaining, setRemaining] = useState<string[]>([]);
  const [answered, setAnswered] = useState(0);
  const [current, setCurrent] = useState<Current | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [options, setOptions] = useState<string[]>([]);
  const [numText, setNumText] = useState("");
  const [theoryText, setTheoryText] = useState("");
  const [selfMark, setSelfMark] = useState(false); // waiting for "how did you do?"
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = useCallback(async () => {
    await supabase().from("practice_sessions").update({ ended_at: new Date().toISOString() }).eq("id", sessionId).is("ended_at", null);
    router.replace(`/practice/${sessionId}/summary`);
  }, [router, sessionId]);

  const load = useCallback(async (id: string) => {
    setCurrent(null);
    setAttempt(null);
    setOptions([]);
    setNumText("");
    setTheoryText("");
    setSelfMark(false);
    setError(null);
    const db = supabase();
    const [qr, ar] = await Promise.all([
      db.from("questions").select("*").eq("id", id).single(),
      db.from("answers").select("*").eq("question_id", id).maybeSingle(),
    ]);
    if (qr.error) throw new Error(qr.error.message);
    const q = qr.data as Question;
    const urls = await signedUrls("crops", q.image_paths);
    setCurrent({ q, answer: (ar.data as Answer | null) ?? null, urls: q.image_paths.map((p) => urls[p]).filter(Boolean) });
  }, []);

  useEffect(() => {
    (async () => {
      const db = supabase();
      const sr = await db.from("practice_sessions").select("*").eq("id", sessionId).maybeSingle();
      if (sr.error) throw new Error(sr.error.message);
      const s = sr.data as PracticeSession | null;
      if (!s) throw new Error("This practice session doesn't exist.");
      if (s.ended_at) return router.replace(`/practice/${sessionId}/summary`);
      setSession(s);
      // Rebuild the queue from the saved filters, minus what this session already answered.
      const [cands, done, hier] = await Promise.all([
        findCandidates(s.filters, s.mode),
        db.from("attempts").select("question_id").eq("session_id", sessionId),
        loadHierarchy(),
      ]);
      if (done.error) throw new Error(done.error.message);
      setH(hier);
      const seen = new Set((done.data ?? []).map((a) => a.question_id as string));
      const queue = shuffle(cands.map((c) => c.question_id).filter((id) => !seen.has(id)));
      setAnswered(seen.size);
      setRemaining(queue);
      if (!queue.length || (s.target_count && seen.size >= s.target_count)) return finish();
      await load(queue[0]);
    })().catch((e) => setError((e as Error).message));
  }, [sessionId, router, finish, load]);

  async function record(userAnswer: string, verdict: Verdict, source: "auto" | "self") {
    if (!current) return;
    setBusy(true);
    const { data, error } = await supabase()
      .from("attempts")
      .insert({ question_id: current.q.id, session_id: sessionId, user_answer: userAnswer, verdict, verdict_source: source })
      .select("*")
      .single();
    setBusy(false);
    if (error) return setError(error.message);
    setAttempt(data as Attempt);
    setSelfMark(false);
    setAnswered((n) => n + 1);
  }

  function check() {
    if (!current) return;
    const { q, answer } = current;
    setError(null);
    if (q.type === "theory") return setSelfMark(true);
    if (q.type === "numerical") {
      if (parseUserNumber(numText) === null) return setError("Enter a number, like 9.8 or -0.5.");
    } else if (!options.length) {
      return setError(q.type === "mcq" ? "Tap an option first." : "Tap every option you think is correct.");
    }
    if (!canAutoGrade(q.type, answer)) return setSelfMark(true);

    if (q.type === "mcq") return record(options[0], gradeMcq(options[0], answer!.correct_options!), "auto");
    if (q.type === "msq") return record(options.join(","), gradeMsq(options, answer!.correct_options!), "auto");
    const [min, max] = numericRange(answer!)!;
    return record(numText.trim(), gradeNumeric(parseUserNumber(numText)!, min, max), "auto");
  }

  function userAnswerText(): string {
    if (!current) return "";
    if (current.q.type === "numerical") return numText.trim();
    if (current.q.type === "theory") return theoryText.trim();
    return options.join(",");
  }

  async function override(verdict: Verdict) {
    if (!attempt) return;
    const original = attempt.original_verdict ?? (attempt.verdict_source === "self" ? null : attempt.verdict);
    const { data, error } = await supabase()
      .from("attempts")
      .update({ verdict, verdict_source: "self", original_verdict: original })
      .eq("id", attempt.id)
      .select("*")
      .single();
    if (error) return setError(error.message);
    setAttempt(data as Attempt);
  }

  async function next() {
    const rest = remaining.slice(1);
    setRemaining(rest);
    if (!rest.length || (session?.target_count && answered >= session.target_count)) return finish();
    try {
      await load(rest[0]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleStar() {
    if (!current) return;
    const value = !current.q.is_starred;
    setCurrent({ ...current, q: { ...current.q, is_starred: value } });
    const { error } = await supabase().from("questions").update({ is_starred: value }).eq("id", current.q.id);
    if (error) setError(error.message);
  }

  const total = session ? (session.target_count ? Math.min(session.target_count, answered + remaining.length - (attempt ? 1 : 0)) : null) : null;
  const position = answered + (attempt ? 0 : 1);
  const title = session?.mode === "theory" ? "Theory revision" : "Practice";

  if (!current) {
    return (
      <>
        <TopBar title={title} back={session?.mode === "theory" ? "/theory" : "/practice"} />
        <main className="px-4 py-4">{error ? <ErrorNote>{error}</ErrorNote> : <Loading />}</main>
      </>
    );
  }

  const { q, answer } = current;
  const section = h?.sections.find((s) => s.id === q.section_id);
  const stored = formatAnswer(answer);
  const showSolution = !!attempt || selfMark;

  return (
    <>
      <TopBar
        title={
          <span>
            <span className="qnum">{q.number}</span>
            <span className="ml-2 text-base font-normal text-muted">
              {total ? `${position} of ${total}` : `${position} answered`}
            </span>
          </span>
        }
        subtitle={h && section ? pathLabel(h, section.chapter_id, section.id) : undefined}
        back={session?.mode === "theory" ? "/theory" : "/practice"}
        right={
          <button type="button" className="btn-icon" aria-label={q.is_starred ? "Unstar" : "Star"} aria-pressed={q.is_starred} onClick={toggleStar}>
            <Star size={22} className={q.is_starred ? "text-mark" : ""} fill={q.is_starred ? "currentColor" : "none"} />
          </button>
        }
      />
      <main className="space-y-4 px-4 py-4">
        <section className="card overflow-hidden bg-white">
          {current.urls.map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={u} src={u} alt={`Question ${q.number}, part ${i + 1}`} className="block w-full" />
          ))}
        </section>

        {(q.type === "mcq" || q.type === "msq") && (
          <div className="space-y-2">
            <p className="text-sm text-muted">{q.type === "mcq" ? "Choose one option" : "Choose all correct options"}</p>
            <OptionPad
              value={options}
              onChange={setOptions}
              multiple={q.type === "msq"}
              disabled={showSolution}
              correct={attempt && answer?.correct_options ? answer.correct_options : undefined}
            />
          </div>
        )}

        {q.type === "numerical" && (
          <input
            className="field text-center text-2xl font-bold"
            inputMode="decimal"
            placeholder="Your answer"
            aria-label="Your answer"
            value={numText}
            disabled={showSolution}
            onChange={(e) => setNumText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && check()}
          />
        )}

        {q.type === "theory" && (
          <textarea
            rows={5}
            className="field py-3"
            placeholder="Write your answer (optional), then reveal the model answer"
            aria-label="Your answer"
            value={theoryText}
            disabled={showSolution}
            onChange={(e) => setTheoryText(e.target.value)}
          />
        )}

        {error && <ErrorNote>{error}</ErrorNote>}

        {attempt && (
          <div className={`rounded-2xl border-2 px-4 py-3 ${VERDICT_TONE[attempt.verdict]}`} role="status">
            <p className="text-xl font-bold">{VERDICT_TEXT[attempt.verdict]}</p>
            {attempt.verdict_source === "self" && attempt.original_verdict && (
              <p className="text-sm">You overrode the check ({VERDICT_TEXT[attempt.original_verdict].toLowerCase()}).</p>
            )}
          </div>
        )}

        {showSolution && (
          <section className="card space-y-2 p-4">
            <h2 className="font-bold">Answer</h2>
            {stored && <p className="text-xl font-bold">{stored}</p>}
            {answer?.answer_text && <p className="whitespace-pre-wrap">{answer.answer_text}</p>}
            {answer?.answer_image_path && <SolutionImage path={answer.answer_image_path} number={q.number} />}
            {!answer && (
              <p className="text-muted">
                No answer saved for this question.{" "}
                <Link href={`/library/question/${q.id}`} className="font-bold text-accent">
                  Add one
                </Link>
              </p>
            )}
          </section>
        )}

        {attempt && (
          <div className="flex flex-wrap gap-2">
            {attempt.verdict !== "correct" && (
              <button type="button" className="chip" onClick={() => override("correct")}>
                Override: I was right
              </button>
            )}
            {attempt.verdict !== "wrong" && (
              <button type="button" className="chip" onClick={() => override("wrong")}>
                Override: I was wrong
              </button>
            )}
          </div>
        )}

        <ShareButtons urls={current.urls} number={q.number} text={q.ocr_text} />

        <button type="button" className="w-full py-3 text-sm font-bold text-muted underline" onClick={finish}>
          End session
        </button>
        <div className="h-24" aria-hidden />
      </main>

      {/* One-handed action bar above the navigation */}
      <div className="fixed inset-x-0 z-20 border-t border-line bg-surface" style={{ bottom: "calc(4rem + env(safe-area-inset-bottom, 0px))" }}>
        <div className="mx-auto max-w-xl px-4 py-3">
          {attempt ? (
            <button type="button" className="btn-primary w-full text-lg" onClick={next}>
              Next question
            </button>
          ) : selfMark ? (
            <div className="space-y-2">
              <p className="text-center text-sm text-muted">How did you do?</p>
              <div className={`grid gap-2 ${q.type === "theory" ? "grid-cols-3" : "grid-cols-2"}`}>
                <button type="button" className="btn-secondary text-bad" disabled={busy} onClick={() => record(userAnswerText(), "wrong", "self")}>
                  Missed it
                </button>
                {q.type === "theory" && (
                  <button type="button" className="btn-secondary text-part" disabled={busy} onClick={() => record(userAnswerText(), "partial", "self")}>
                    Partly
                  </button>
                )}
                <button type="button" className="btn-secondary text-ok" disabled={busy} onClick={() => record(userAnswerText(), "correct", "self")}>
                  Got it
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn-primary w-full text-lg" disabled={busy} onClick={check}>
              {q.type === "theory" ? (
                <>
                  <Eye size={20} aria-hidden /> Show answer
                </>
              ) : (
                "Check"
              )}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
