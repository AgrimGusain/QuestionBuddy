import { fetchAll } from "./fetch-all";
import { supabase } from "./supabase/client";
import type { PracticeFilters, QuestionOverview } from "./types";

export const EMPTY_FILTERS: PracticeFilters = {
  subjectIds: [],
  chapterIds: [],
  starred: false,
  theory: false,
  status: "any",
};

type Candidate = Pick<QuestionOverview, "question_id" | "last_verdict" | "attempt_count">;

/** Questions matching the source selector. Theory mode always restricts to theory questions. */
export async function findCandidates(filters: PracticeFilters, mode: "practice" | "theory"): Promise<Candidate[]> {
  return fetchAll<Candidate>((from, to) => {
    let q = supabase()
      .from("question_overview")
      .select("question_id, last_verdict, attempt_count")
      .order("question_id")
      .range(from, to);
    if (filters.chapterIds.length) q = q.in("chapter_id", filters.chapterIds);
    else if (filters.subjectIds.length) q = q.in("subject_id", filters.subjectIds);
    if (filters.starred) q = q.eq("is_starred", true);
    if (filters.theory || mode === "theory") q = q.eq("is_theory", true);
    if (filters.status === "unattempted") q = q.eq("attempt_count", 0);
    if (filters.status === "wrong") q = q.eq("last_verdict", "wrong");
    return q;
  });
}

/** Fisher–Yates. Phase 5 replaces this with weighting towards wrong answers. */
export function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
