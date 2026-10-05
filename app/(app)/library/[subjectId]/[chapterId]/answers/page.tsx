"use client";

import { ChevronRight, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { applyKeyEntry, editEntry, rematch, setEntryStatus, storedParse } from "@/lib/answer-key/client";
import { describeParsed } from "@/lib/answer-key/parse";
import { fetchAll, inChunks } from "@/lib/fetch-all";
import { loadHierarchy, type Hierarchy } from "@/lib/hierarchy";
import { compareQuestionNumbers } from "@/lib/number";
import { formatAnswer } from "@/lib/grading";
import { supabase } from "@/lib/supabase/client";
import type { Answer, AnswerKeyEntry, QuestionType } from "@/lib/types";

const REASONS: Record<string, string> = {
  differs_from_your_answer: "The key differs from the answer you typed.",
  differs_from_key_answer: "The key differs from the answer another key page gave.",
  multiple_options_on_mcq: "The key gives several options, but the question is single-choice (MCQ).",
  option_on_numerical: "The key gives an option, but the question is numerical.",
  number_on_mcq: "The key gives a number, but the question is multiple-choice.",
  option_on_theory: "The key gives an option, but the question is theory.",
  unreadable_answer: "The key's answer couldn't be read as an option or a number.",
  key_no_answer: "The key gives no answer here (bonus/dropped).",
  duplicate_number: "This number appears twice in this section on one key page.",
  key_pages_disagree: "Two key pages give different answers.",
};

interface QRow {
  question_id: string;
  section_id: string;
  number: string;
  number_normalized: string;
  type: QuestionType;
  has_answer: boolean;
}

const keyText = (e: AnswerKeyEntry) => (e.kind === "worked" ? "worked solution" : `“${e.raw_text}” → ${describeParsed(storedParse(e))}`);

type EntryEdit = { number: string; sectionId: string | null; raw?: string };

/** Change an entry's number, section and answer, or point it at a question picked from the list. */
function EditForm({
  e,
  sections,
  questions,
  disabled,
  onSubmit,
}: {
  e: AnswerKeyEntry;
  sections: { id: string; name: string }[];
  questions: QRow[];
  disabled: boolean;
  onSubmit: (edit: EntryEdit) => void;
}) {
  const [number, setNumber] = useState(e.number);
  const [sectionId, setSectionId] = useState(e.section_id ?? "");
  const [raw, setRaw] = useState(e.raw_text);
  const [pick, setPick] = useState("");
  const name = (id: string) => sections.find((s) => s.id === id)?.name ?? "?";
  const rawEdit = e.kind === "short" ? raw : undefined;
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-sunken p-3">
      <div className="flex gap-2">
        <input className="field w-20 text-center" aria-label="Number" value={number} onChange={(ev) => setNumber(ev.target.value)} />
        <select className="field" aria-label="Section" value={sectionId} onChange={(ev) => setSectionId(ev.target.value)}>
          <option value="">No section</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {e.kind === "short" && <input className="field" aria-label="Answer as printed" value={raw} onChange={(ev) => setRaw(ev.target.value)} />}
      <button
        type="button"
        className="btn-primary w-full"
        disabled={disabled || !number.trim()}
        onClick={() => onSubmit({ number, sectionId: sectionId || null, raw: rawEdit })}
      >
        Save and match again
      </button>
      <div className="flex gap-2">
        <select className="field" aria-label="Pick a question" value={pick} onChange={(ev) => setPick(ev.target.value)}>
          <option value="">…or pick a question</option>
          {questions.map((q) => (
            <option key={q.question_id} value={q.question_id}>
              Q{q.number} · {name(q.section_id)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={!pick || disabled}
          onClick={() => {
            const q = questions.find((x) => x.question_id === pick);
            if (q) onSubmit({ number: q.number, sectionId: q.section_id, raw: rawEdit });
          }}
        >
          Use it
        </button>
      </div>
    </div>
  );
}

function QuestionLink({ id, label }: { id: string | null; label: string }) {
  return id ? (
    <Link href={`/library/question/${id}`} className="inline-flex items-center gap-1 font-bold text-accent">
      {label} <ChevronRight size={14} aria-hidden />
    </Link>
  ) : (
    <span className="font-bold">{label}</span>
  );
}

export default function AnswerMatchingPage() {
  const { subjectId, chapterId } = useParams<{ subjectId: string; chapterId: string }>();
  const [h, setH] = useState<Hierarchy | null>(null);
  const [entries, setEntries] = useState<AnswerKeyEntry[] | null>(null);
  const [questions, setQuestions] = useState<QRow[]>([]);
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const db = supabase();
    const [hier, es, qs] = await Promise.all([
      loadHierarchy(),
      fetchAll<AnswerKeyEntry>((from, to) => db.from("answer_key_entries").select("*").eq("chapter_id", chapterId).order("created_at").range(from, to)),
      fetchAll<QRow>((from, to) =>
        db.from("question_overview").select("question_id, section_id, number, number_normalized, type, has_answer").eq("chapter_id", chapterId).range(from, to),
      ),
    ]);
    const conflictQs = [...new Set(es.filter((e) => e.question_id && (e.status === "conflict" || e.status === "kept_mine")).map((e) => e.question_id!))];
    const ans = await inChunks(conflictQs, async (chunk) => {
      const { data, error } = await db.from("answers").select("*").in("question_id", chunk);
      if (error) throw new Error(error.message);
      return (data ?? []) as Answer[];
    });
    setH(hier);
    setEntries(es);
    setQuestions(qs.sort((a, b) => compareQuestionNumbers(a.number, b.number)));
    setAnswers(new Map(ans.map((a) => [a.question_id, a])));
  }, [chapterId]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  const sections = useMemo(() => (h ? h.sections.filter((s) => s.chapter_id === chapterId) : []), [h, chapterId]);
  const sectionName = (id: string | null) => (id ? (sections.find((s) => s.id === id)?.name ?? "?") : "No section");
  const question = (id: string | null) => questions.find((q) => q.question_id === id);

  /** Run an action, then reload; one at a time. */
  async function act(id: string, fn: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!entries || !h) {
    return (
      <>
        <TopBar title="Answer key" back={`/library/${subjectId}/${chapterId}`} />
        {error ? (
          <main className="px-4 py-4">
            <ErrorNote>{error}</ErrorNote>
          </main>
        ) : (
          <Loading />
        )}
      </>
    );
  }

  const chapter = h.chapters.find((c) => c.id === chapterId);
  const matchedQuestions = new Set(entries.filter((e) => e.status === "matched" && e.question_id).map((e) => e.question_id));
  const conflicts = entries.filter((e) => e.status === "conflict");
  const noQuestion = entries.filter((e) => e.status === "unmatched");
  const kept = entries.filter((e) => e.status === "kept_mine");
  const ignored = entries.filter((e) => e.status === "ignored");
  const noAnswer = questions.filter((q) => !q.has_answer);

  return (
    <>
      <TopBar title="Answer key" subtitle={chapter?.name} back={`/library/${subjectId}/${chapterId}`} />
      <main className="space-y-6 px-4 py-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="grid grid-cols-2 gap-2 text-center">
          {[
            ["Matched", matchedQuestions.size],
            ["Conflicts", conflicts.length],
            ["No question", noQuestion.length],
            ["No answer", noAnswer.length],
          ].map(([label, n]) => (
            <div key={label} className="card p-3">
              <span className="block text-2xl font-bold">{n}</span>
              <span className="text-sm text-muted">{label}</span>
            </div>
          ))}
        </div>
        {entries.length === 0 && <p className="text-muted">No answer-key pages saved for this chapter yet.</p>}

        {conflicts.length > 0 && (
          <section className="space-y-2">
            <h2 className="font-bold">Conflicts</h2>
            <ul className="space-y-2">
              {conflicts.map((e) => {
                const q = question(e.question_id);
                const current = e.question_id ? answers.get(e.question_id) : undefined;
                const reason = e.conflict_reason ?? "";
                const differs = reason === "differs_from_your_answer" || reason === "differs_from_key_answer";
                return (
                  <li key={e.id} className="card space-y-2 p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <QuestionLink id={e.question_id} label={`Q${q?.number ?? e.number}`} />
                      <span className="text-sm text-muted">{sectionName(e.section_id)}</span>
                    </div>
                    <p className="text-sm text-bad">{REASONS[reason] ?? reason}</p>
                    <p className="text-sm">
                      <span className="text-muted">Key: </span>
                      {keyText(e)}
                      {differs && current && (
                        <>
                          <br />
                          <span className="text-muted">{current.source_page_id ? "Current (from a key): " : "Yours: "}</span>
                          {formatAnswer(current) || current.answer_text || "—"}
                        </>
                      )}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {differs && (
                        <>
                          <button type="button" className="chip" disabled={busy === e.id} onClick={() => act(e.id, () => applyKeyEntry(e.id))}>
                            Use key answer
                          </button>
                          <button type="button" className="chip" disabled={busy === e.id} onClick={() => act(e.id, () => setEntryStatus(e, "kept_mine"))}>
                            Keep mine
                          </button>
                        </>
                      )}
                      {reason === "multiple_options_on_mcq" && q && (
                        <button
                          type="button"
                          className="chip"
                          disabled={busy === e.id}
                          onClick={() =>
                            act(e.id, async () => {
                              const { error: err } = await supabase().from("questions").update({ type: "msq" }).eq("id", q.question_id);
                              if (err) throw new Error(err.message);
                              await rematch(chapterId);
                            })
                          }
                        >
                          Change question to MSQ
                        </button>
                      )}
                      {!differs && (
                        <button type="button" className="chip" onClick={() => setEditing(editing === e.id ? null : e.id)}>
                          Edit
                        </button>
                      )}
                      <button type="button" className="chip" disabled={busy === e.id} onClick={() => act(e.id, () => setEntryStatus(e, "ignored"))}>
                        Ignore
                      </button>
                    </div>
                    {editing === e.id && <EditForm e={e} sections={sections} questions={questions} disabled={busy === e.id} onSubmit={(edit) => act(e.id, () => editEntry(e, edit))} />}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {noQuestion.length > 0 && (
          <section className="space-y-2">
            <h2 className="font-bold">Answers with no question</h2>
            <p className="text-sm text-muted">
              These match automatically once a question with the same number is saved in the same section. Fix the number or section
              if it was read wrong.
            </p>
            <ul className="space-y-2">
              {noQuestion.map((e) => (
                <li key={e.id} className="card space-y-2 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-bold">{e.number}</span>
                    <span className={`text-sm ${e.section_id ? "text-muted" : "text-bad"}`}>{sectionName(e.section_id)}</span>
                  </div>
                  <p className="text-sm">{keyText(e)}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="chip" onClick={() => setEditing(editing === e.id ? null : e.id)}>
                      Change number/section or pick question
                    </button>
                    <button type="button" className="chip" disabled={busy === e.id} onClick={() => act(e.id, () => setEntryStatus(e, "ignored"))}>
                      Ignore
                    </button>
                  </div>
                  {editing === e.id && <EditForm e={e} sections={sections} questions={questions} disabled={busy === e.id} onSubmit={(edit) => act(e.id, () => editEntry(e, edit))} />}
                </li>
              ))}
            </ul>
          </section>
        )}

        {noAnswer.length > 0 && (
          <section className="space-y-2">
            <h2 className="font-bold">Questions with no answer</h2>
            <ul className="flex flex-wrap gap-2">
              {noAnswer.map((q) => (
                <li key={q.question_id}>
                  <Link href={`/library/question/${q.question_id}`} className="chip">
                    Q{q.number} <span className="text-muted">· {sectionName(q.section_id)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {kept.length > 0 && (
          <section className="space-y-2">
            <h2 className="font-bold">Kept your answer</h2>
            <ul className="space-y-2">
              {kept.map((e) => (
                <li key={e.id} className="card flex items-center gap-3 p-3">
                  <span className="min-w-0 flex-1 text-sm">
                    <QuestionLink id={e.question_id} label={`Q${question(e.question_id)?.number ?? e.number}`} /> · key {keyText(e)}
                  </span>
                  <button type="button" className="chip shrink-0" disabled={busy === e.id} onClick={() => act(e.id, () => setEntryStatus(e, "unmatched"))}>
                    <RotateCcw size={14} aria-hidden /> Undo
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {ignored.length > 0 && (
          <section className="space-y-2">
            <h2 className="font-bold">Ignored</h2>
            <ul className="space-y-2">
              {ignored.map((e) => (
                <li key={e.id} className="card flex items-center gap-3 p-3">
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-bold">{e.number}</span> · {sectionName(e.section_id)} · {keyText(e)}
                  </span>
                  <button type="button" className="chip shrink-0" disabled={busy === e.id} onClick={() => act(e.id, () => setEntryStatus(e, "unmatched"))}>
                    <RotateCcw size={14} aria-hidden /> Undo
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
