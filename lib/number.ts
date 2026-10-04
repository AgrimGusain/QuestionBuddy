/**
 * Mirror of SQL normalize_question_number() — keep the two in sync
 * (lib/number.test.ts checks the same cases as the migration tests).
 *   "Q58", "Q.58", "58.", "(58)", " 58 " -> "58";  "12(a)" -> "12a";  "1.2" -> "1.2"
 */
export function normalizeQuestionNumber(n: string): string {
  return n
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^(question|ques|q|no)\.?(?=[0-9])/, "")
    .replace(/[()[\]]/g, "")
    .replace(/^[.:#]+|[.:]+$/g, "");
}

/** Natural order: 2 < 10 < 10a. */
export function compareQuestionNumbers(a: string, b: string): number {
  return normalizeQuestionNumber(a).localeCompare(normalizeQuestionNumber(b), undefined, {
    numeric: true,
  });
}

/** Suggest the number after `prev` ("58" -> "59", "12a" -> "13"); "1" when unknown. */
export function nextQuestionNumber(prev?: string): string {
  const m = prev ? normalizeQuestionNumber(prev).match(/^(\d+)/) : null;
  return m ? String(Number(m[1]) + 1) : "1";
}
