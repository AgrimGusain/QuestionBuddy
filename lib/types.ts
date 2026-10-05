import type { AiResult } from "./segment/schema";

export type QuestionType = "mcq" | "msq" | "numerical" | "theory";
export type Verdict = "correct" | "partial" | "wrong";
export type VerdictSource = "auto" | "ai" | "self";
export type PageKind = "questions" | "answer_key";
export type PageStatus =
  | "uploaded" | "queued" | "processing" | "rate_limited"
  | "needs_review" | "saved" | "failed";
export type Bucket = "pages" | "crops";

export interface Subject { id: string; name: string; created_at: string }
export interface Chapter { id: string; subject_id: string; name: string; position: number }
export interface Section { id: string; chapter_id: string; name: string; position: number }

export interface PageRow {
  id: string;
  chapter_id: string;
  section_id: string | null;
  kind: PageKind;
  status: PageStatus;
  original_path: string;
  processed_path: string | null;
  retry_after: string | null;
  retry_count: number;
  ai_result: AiResult | null;
  ai_model: string | null;
  ai_processed_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type { AiResult, AiQuestion } from "./segment/schema";

export interface Question {
  id: string;
  section_id: string;
  page_id: string | null;
  number: string;
  number_normalized: string;
  type: QuestionType;
  image_paths: string[];
  options: string[] | null;
  ocr_text: string;
  is_starred: boolean;
  is_theory: boolean;
  explanation: string | null;
  created_at: string;
}

export interface Answer {
  id: string;
  question_id: string;
  answer_text: string | null;
  answer_image_path: string | null;
  correct_options: string[] | null;
  numeric_min: number | string | null; // Postgres numeric may arrive as a string
  numeric_max: number | string | null;
}

/** Row of the question_overview view. */
export interface QuestionOverview {
  question_id: string;
  section_id: string;
  chapter_id: string;
  subject_id: string;
  number: string;
  number_normalized: string;
  type: QuestionType;
  is_starred: boolean;
  is_theory: boolean;
  ocr_text: string;
  created_at: string;
  image_paths: string[];
  thumbnail_path: string;
  has_answer: boolean;
  attempt_count: number;
  wrong_count: number;
  last_verdict: Verdict | null;
  last_attempted_at: string | null;
}

export interface PracticeFilters {
  subjectIds: string[];
  chapterIds: string[]; // when non-empty, narrows within the chosen subjects
  starred: boolean;
  theory: boolean;
  status: "any" | "unattempted" | "wrong";
}

export interface PracticeSession {
  id: string;
  mode: "practice" | "theory";
  filters: PracticeFilters;
  target_count: number | null;
  started_at: string;
  ended_at: string | null;
}

export interface Attempt {
  id: string;
  question_id: string;
  session_id: string | null;
  user_answer: string;
  verdict: Verdict;
  verdict_source: VerdictSource;
  original_verdict: Verdict | null;
  created_at: string;
}

export const TYPE_LABEL: Record<QuestionType, string> = {
  mcq: "Single choice",
  msq: "Multiple choice",
  numerical: "Numerical",
  theory: "Theory",
};

export const TYPE_SHORT: Record<QuestionType, string> = {
  mcq: "MCQ",
  msq: "MSQ",
  numerical: "Num",
  theory: "Theory",
};

export const OPTION_LETTERS = ["a", "b", "c", "d", "e"] as const;
