import { z } from "zod";

type Box = [number, number, number, number];
const Box2d = z.tuple([z.number(), z.number(), z.number(), z.number()]);
/** Models sometimes send numbers as JSON numbers; keep them as text. */
const Num = z.union([z.string().min(1).max(20), z.number()]).transform(String);

/** What the layout model (Gemini) returns for an answer-key page: positions only, never answers. */
export const KeyLayoutResponseSchema = z.object({
  columns: z.union([z.literal(1), z.literal(2)]),
  headings: z.array(z.object({ text: z.string().max(120), box_2d: Box2d })).default([]),
  key_regions: z
    .array(
      z.object({
        box_2d: Box2d,
        rows: z.number().int().min(1).max(80),
        columns: z.number().int().min(1).max(20),
        first_number: Num,
        last_number: Num,
      }),
    )
    .default([]),
  solutions: z.array(z.object({ number: Num, column: z.union([z.literal(1), z.literal(2)]), box_2d: Box2d })).default([]),
});

/** What the reading model (Groq) returns for one crop of a short-answer table. */
export const KeyEntriesResponseSchema = z.object({
  entries: z.array(z.object({ number: Num, answer: z.string().max(200) })),
});

/** What the reading model returns for one worked-solution crop. */
export const WorkedReadResponseSchema = z.object({
  text: z.string(),
  stated_answer: z.string().nullable().optional(),
});

export interface KeyHeading {
  text: string;
  bbox: Box;
}

export interface KeyLayout {
  columns: 1 | 2;
  headings: KeyHeading[];
  regions: { bbox: Box; rows: number; columns: number; first: string; last: string }[];
  solutions: { number: string; column: 1 | 2; bbox: Box }[];
}

export interface KeyEntryRead {
  number: string;
  answer: string;
}

/** Progress of one short-answer table while it's being read (in pages.ai_progress). */
export interface KeyRegionProgress {
  bbox: Box;
  rows: number;
  columns: number;
  first: string;
  last: string;
  /** null entries = this piece not read yet. */
  chunks: { bbox: Box; entries: KeyEntryRead[] | null; failed?: boolean }[];
  /** null = not checked yet; after the check, the numbers still missing. */
  missing: string[] | null;
  /** Whether the one targeted re-read of missing numbers has been done. */
  reread: boolean;
}

export interface KeySolutionProgress {
  number: string;
  column: 1 | 2;
  bboxRaw: Box;
  bboxSnapped: Box;
  /** null = not read yet. */
  text: string | null;
  statedAnswer: string | null;
  unread?: boolean;
}

/** pages.ai_progress for an answer-key page part-way through reading. */
export interface KeyAiProgress {
  kind: "answer_key";
  layoutModel: string;
  columns: 1 | 2;
  headings: KeyHeading[];
  regions: KeyRegionProgress[];
  solutions: KeySolutionProgress[];
}

/** One entry as read, shown on the key review screen. */
export interface KeyAiEntry {
  number: string;
  kind: "short" | "worked";
  /** Short: the answer exactly as read. Worked: the solution text. */
  raw: string;
  bbox: Box;
  /** Index into KeyAiResult.regions for short entries. */
  region: number | null;
  statedAnswer: string | null;
  flags: { unread?: boolean };
}

/** pages.ai_result for an answer-key page once read. */
export interface KeyAiResult {
  kind: "answer_key";
  model: string;
  columns: 1 | 2;
  headings: KeyHeading[];
  regions: { bbox: Box; rows: number; columns: number; first: string; last: string; missing: string[] }[];
  entries: KeyAiEntry[];
}

/** Whether a stored ai_result is an answer-key page's. */
export function isKeyResult(r: unknown): r is KeyAiResult {
  return !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "answer_key";
}
