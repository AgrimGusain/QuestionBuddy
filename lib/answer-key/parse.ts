/**
 * Turns the raw text of one answer-key entry ("(c)", "(a; c)", "4.4 to 4.6",
 * "Bonus", …) into structured fields. Deterministic on purpose: the model
 * only copies the text, this decides what it means. Runs on the review
 * screen (preview) and again on the server at save time (authoritative).
 */

export type ParseFlag =
  /** "(1)"–"(4)": read as option a–d, but could be the number; the question's type decides. */
  | "digit_option"
  /** Bonus / Dropped / None …: the key gives no answer. */
  | "no_answer"
  /** Not an option or number; kept as text. */
  | "unparsed"
  /** A range written high-to-low ("4.6 to 4.4"); stored low-to-high. */
  | "range_swapped";

export interface ParsedAnswer {
  options: string[] | null; // sorted, unique, a–e
  numericMin: number | null;
  numericMax: number | null; // equal to numericMin for a single value
  text: string | null; // only when nothing else could be read
  flags: ParseFlag[];
}

const NO_ANSWER = /^(bonus|dropped|none|deleted|cancell?ed|no answer|marks? to all|\*+)$/i;
const PREFIX = /^(ans(wer)?s?)\s*[.:\-–]?\s*/i;
const NUM = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;
const SINGLE = new RegExp(`^${NUM}$`);
const RANGE = new RegExp(`^(${NUM})\\s*(?:to|–|—|-|~)\\s*(${NUM})$`, "i");
const DIGIT_OPTION = /^\(\s*([1-4])\s*\)$/;
const LETTERS = "abcd";

function empty(flags: ParseFlag[] = []): ParsedAnswer {
  return { options: null, numericMin: null, numericMax: null, text: null, flags };
}

/** Split on the separators people use between options: , ; / & + and/or/both. */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\b(both|and|or)\b|[,;/&+]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function parseAnswer(raw: string): ParsedAnswer {
  let s = raw
    .replace(/−/g, "-") // Unicode minus
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(PREFIX, "").trim();
  s = s.replace(/[.;,]+$/, "").trim();
  if (!s) return { ...empty(["unparsed"]) };

  if (NO_ANSWER.test(s)) return empty(["no_answer"]);

  // "(3)": option c, or the number 3 — keep both, the question type picks.
  const digit = DIGIT_OPTION.exec(s);
  if (digit) {
    const n = Number(digit[1]);
    return { options: [LETTERS[n - 1]], numericMin: n, numericMax: n, text: null, flags: ["digit_option"] };
  }

  // "(1) and (3)", "(1), (4)": several digit options.
  const digitTokens = tokens(s);
  if (digitTokens.length > 1 && digitTokens.every((t) => DIGIT_OPTION.test(t))) {
    const opts = [...new Set(digitTokens.map((t) => LETTERS[Number(DIGIT_OPTION.exec(t)![1]) - 1]))].sort();
    return { options: opts, numericMin: null, numericMax: null, text: null, flags: ["digit_option"] };
  }

  // Letters: "(c)", "C", "(a, c)", "(a) and (c)", "a,c", "Both (a) and (b)".
  const letterTokens = tokens(s.replace(/[()[\]]/g, " "));
  if (letterTokens.length && letterTokens.every((t) => /^[a-e]$/.test(t))) {
    return { options: [...new Set(letterTokens)].sort(), numericMin: null, numericMax: null, text: null, flags: [] };
  }

  // Numbers: "4.5", "-0.25", "(19)", "4.4 to 4.6", "4.4-4.6", "4.4 – 4.6".
  const bare = s.replace(/^\((.*)\)$/, "$1").trim();
  if (SINGLE.test(bare)) {
    const n = Number(bare);
    return { options: null, numericMin: n, numericMax: n, text: null, flags: [] };
  }
  const range = RANGE.exec(bare);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return a <= b
      ? { options: null, numericMin: a, numericMax: b, text: null, flags: [] }
      : { options: null, numericMin: b, numericMax: a, text: null, flags: ["range_swapped"] };
  }

  return { options: null, numericMin: null, numericMax: null, text: s, flags: ["unparsed"] };
}

/** Short human-readable form of a parsed answer, for review lists. */
export function describeParsed(p: ParsedAnswer): string {
  if (p.flags.includes("no_answer")) return "no answer (bonus/dropped)";
  const parts: string[] = [];
  if (p.options) parts.push(p.options.join(", "));
  if (p.numericMin !== null) {
    parts.push(p.numericMin === p.numericMax ? String(p.numericMin) : `${p.numericMin} to ${p.numericMax}`);
  }
  if (parts.length) return parts.join(" or ");
  return p.text ? `text: ${p.text}` : "nothing read";
}
