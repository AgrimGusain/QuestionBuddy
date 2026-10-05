import { nextQuestionNumber, normalizeQuestionNumber } from "../number";
import type { LocatedQuestion, QuestionFlags } from "./schema";

const MIN_AREA = 0.01; // 1% of the page
const INTEGER = /^\d+$/;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export type CleanedQuestion = LocatedQuestion & { flags: QuestionFlags };

/** Clamp/fix bboxes, drop slivers, sort into reading order, flag duplicates and gaps. */
export function cleanupQuestions(questions: LocatedQuestion[]): CleanedQuestion[] {
  const fixed = questions
    .map((q) => {
      let [x0, y0, x1, y1] = q.bbox.map(clamp01) as [number, number, number, number];
      if (x0 > x1) [x0, x1] = [x1, x0];
      if (y0 > y1) [y0, y1] = [y1, y0];
      return { ...q, bbox: [x0, y0, x1, y1] as [number, number, number, number] };
    })
    .filter((q) => {
      const [x0, y0, x1, y1] = q.bbox;
      return (x1 - x0) * (y1 - y0) >= MIN_AREA;
    });

  fixed.sort((a, b) => a.column - b.column || a.bbox[1] - b.bbox[1]);

  const counts = new Map<string, number>();
  for (const q of fixed) {
    if (!q.number) continue;
    const key = normalizeQuestionNumber(q.number);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let prev: string | null = null;
  return fixed.map((q) => {
    const key = q.number ? normalizeQuestionNumber(q.number) : null;
    const duplicate_number = !!key && (counts.get(key) ?? 0) > 1;

    let sequence_gap = false;
    if (key && INTEGER.test(key) && !q.continues_from_previous) {
      if (prev && INTEGER.test(prev)) sequence_gap = nextQuestionNumber(prev) !== key;
      prev = key;
    } else if (!q.continues_from_previous) {
      prev = null;
    }

    return { ...q, flags: { duplicate_number, sequence_gap } };
  });
}
