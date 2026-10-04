"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { loadHierarchy, type Hierarchy } from "@/lib/hierarchy";
import { EMPTY_FILTERS, findCandidates } from "@/lib/practice";
import { supabase } from "@/lib/supabase/client";
import type { PracticeFilters } from "@/lib/types";
import { ErrorNote, Loading } from "./Status";

const COUNTS: (number | null)[] = [10, 20, 50, null];
const LAST = (mode: string) => `sqb:last-filters:${mode}`;

/** Pick where questions come from, then start a session. */
export function SourceSelector({ mode }: { mode: "practice" | "theory" }) {
  const router = useRouter();
  const [h, setH] = useState<Hierarchy | null>(null);
  const [filters, setFilters] = useState<PracticeFilters>(EMPTY_FILTERS);
  const [count, setCount] = useState<number | null>(20);
  const [matches, setMatches] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadHierarchy().then(setH).catch((e) => setError(e.message));
    try {
      const saved = JSON.parse(localStorage.getItem(LAST(mode)) ?? "null");
      if (saved) setFilters({ ...EMPTY_FILTERS, ...saved.filters });
      if (saved && "count" in saved) setCount(saved.count);
    } catch {
      // Ignore unreadable saved filters.
    }
  }, [mode]);

  // Live count of matching questions.
  useEffect(() => {
    let live = true;
    setMatches(null);
    const t = setTimeout(() => {
      findCandidates(filters, mode)
        .then((c) => live && setMatches(c.length))
        .catch((e) => live && setError(e.message));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filters, mode]);

  const visibleChapters = useMemo(() => {
    if (!h) return [];
    const subj = filters.subjectIds.length ? filters.subjectIds : h.subjects.map((s) => s.id);
    return h.chapters.filter((c) => subj.includes(c.subject_id));
  }, [h, filters.subjectIds]);

  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  async function start() {
    setStarting(true);
    setError(null);
    localStorage.setItem(LAST(mode), JSON.stringify({ filters, count }));
    const { data, error } = await supabase()
      .from("practice_sessions")
      .insert({ mode, filters, target_count: count })
      .select("id")
      .single();
    if (error) {
      setStarting(false);
      return setError(error.message);
    }
    router.push(`/practice/${data.id}`);
  }

  if (!h) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;

  const subjectName = (id: string) => h.subjects.find((s) => s.id === id)?.name ?? "";

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-bold">Subjects</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="chip"
            aria-pressed={filters.subjectIds.length === 0}
            onClick={() => setFilters({ ...filters, subjectIds: [], chapterIds: [] })}
          >
            All subjects
          </button>
          {h.subjects.map((s) => (
            <button
              key={s.id}
              type="button"
              className="chip"
              aria-pressed={filters.subjectIds.includes(s.id)}
              onClick={() => {
                const subjectIds = toggleIn(filters.subjectIds, s.id);
                const keep = new Set(h.chapters.filter((c) => subjectIds.includes(c.subject_id)).map((c) => c.id));
                setFilters({ ...filters, subjectIds, chapterIds: filters.chapterIds.filter((id) => keep.has(id)) });
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      </section>

      {visibleChapters.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">Chapters</h2>
          <p className="text-sm text-muted">Leave all unselected to use every chapter above.</p>
          <div className="flex flex-wrap gap-2">
            {visibleChapters.map((c) => (
              <button
                key={c.id}
                type="button"
                className="chip"
                aria-pressed={filters.chapterIds.includes(c.id)}
                onClick={() => setFilters({ ...filters, chapterIds: toggleIn(filters.chapterIds, c.id) })}
              >
                {c.name}
                {filters.subjectIds.length !== 1 && <span className="font-normal opacity-75">{subjectName(c.subject_id)}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-bold">Only include</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="chip" aria-pressed={filters.starred} onClick={() => setFilters({ ...filters, starred: !filters.starred })}>
            Starred
          </button>
          {mode === "practice" && (
            <button type="button" className="chip" aria-pressed={filters.theory} onClick={() => setFilters({ ...filters, theory: !filters.theory })}>
              Theory
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Attempt history">
          {(
            [
              ["any", "Any history"],
              ["unattempted", "Never tried"],
              ["wrong", "Got wrong last time"],
            ] as [PracticeFilters["status"], string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={filters.status === v}
              className="chip"
              onClick={() => setFilters({ ...filters, status: v })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">Questions per session</h2>
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Questions per session">
          {COUNTS.map((c) => (
            <button
              key={String(c)}
              type="button"
              role="radio"
              aria-checked={count === c}
              className="chip justify-center px-2"
              onClick={() => setCount(c)}
            >
              {c ?? "Endless"}
            </button>
          ))}
        </div>
      </section>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="sticky space-y-2 bg-bg pb-2 pt-1" style={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}>
        <button type="button" className="btn-primary w-full text-lg" disabled={starting || !matches} onClick={start}>
          {starting
            ? "Starting…"
            : matches === null
              ? "Counting questions…"
              : matches === 0
                ? "No questions match"
                : `Start with ${count ? Math.min(count, matches) : matches} of ${matches} questions`}
        </button>
      </div>
    </div>
  );
}
