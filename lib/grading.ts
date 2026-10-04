import type { Answer, QuestionType, Verdict } from "./types";

const rawTolerance = Number(process.env.NEXT_PUBLIC_NUMERIC_TOLERANCE_PCT);
/** ± percent accepted when a numerical answer is a single value (default 1). */
export const TOLERANCE_PCT =
  process.env.NEXT_PUBLIC_NUMERIC_TOLERANCE_PCT && Number.isFinite(rawTolerance) && rawTolerance >= 0 ? rawTolerance : 1;

function toNumber(v: number | string | null): number | null {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse what a student typed: allows "3,5" as 3.5 and surrounding spaces. */
export function parseUserNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  return Number(cleaned);
}

/**
 * MCQ: correct when the chosen option is in correct_options. With one stored
 * option this is an exact match; a key that accepts several options
 * ("(a) or (c)") also works.
 */
export function gradeMcq(selected: string, correct: string[]): Verdict {
  return correct.includes(selected) ? "correct" : "wrong";
}

/** MSQ: correct only when the selected set exactly equals correct_options. */
export function gradeMsq(selected: string[], correct: string[]): Verdict {
  const a = new Set(selected);
  const b = new Set(correct);
  if (a.size !== b.size) return "wrong";
  for (const x of a) if (!b.has(x)) return "wrong";
  return "correct";
}

/**
 * Numerical: correct when min <= value <= max. When min = max (a single
 * stored value) the ±tolerance percent applies; an exact 0 needs an exact 0.
 */
export function gradeNumeric(
  value: number,
  min: number,
  max: number,
  tolerancePct = TOLERANCE_PCT,
): Verdict {
  if (min !== max) return value >= min && value <= max ? "correct" : "wrong";
  const tol = (Math.abs(min) * tolerancePct) / 100;
  // Small epsilon so a value exactly on the ±tol edge is not lost to float rounding.
  return Math.abs(value - min) <= tol * (1 + 1e-9) + 1e-12 ? "correct" : "wrong";
}

/** True when the stored answer has what's needed to auto-grade this type. */
export function canAutoGrade(type: QuestionType, answer: Answer | null): boolean {
  if (!answer) return false;
  if (type === "mcq" || type === "msq") return !!answer.correct_options?.length;
  if (type === "numerical") return toNumber(answer.numeric_min) !== null;
  return false;
}

export function numericRange(answer: Answer): [number, number] | null {
  const min = toNumber(answer.numeric_min);
  const max = toNumber(answer.numeric_max);
  return min === null || max === null ? null : [min, max];
}

/** Human-readable stored answer, e.g. "(a), (c)" or "3.1 to 3.3". */
export function formatAnswer(answer: Answer | null): string {
  if (!answer) return "";
  const parts: string[] = [];
  if (answer.correct_options?.length) {
    parts.push(answer.correct_options.map((o) => `(${o})`).join(", "));
  }
  const range = numericRange(answer);
  if (range) parts.push(range[0] === range[1] ? `${range[0]}` : `${range[0]} to ${range[1]}`);
  return parts.join("  ");
}
