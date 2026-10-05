import { z } from "zod";

const QuestionType = z.enum(["mcq", "msq", "numerical", "theory"]);

/** What the layout model (Gemini) must return for one question: where it is, never its text. */
export const LayoutQuestionSchema = z.object({
  number: z.string().min(1).max(20).nullable(),
  column: z.union([z.literal(1), z.literal(2)]),
  // Gemini's native convention: [ymin, xmin, ymax, xmax], integers 0-1000.
  box_2d: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  type_guess: QuestionType,
  option_count: z.number().int().min(0).max(10),
  has_diagram: z.boolean(),
  continues_from_previous: z.boolean(),
  continues_to_next: z.boolean(),
});

export const LayoutResponseSchema = z.object({
  columns: z.union([z.literal(1), z.literal(2)]),
  questions: z.array(LayoutQuestionSchema),
});

/** What the reading model (Groq) must return for one cropped question. */
export const ReadResponseSchema = z.object({
  text: z.string(),
  options: z.array(z.string()).nullable(),
});

export type LayoutResponse = z.infer<typeof LayoutResponseSchema>;
export type ReadResponse = z.infer<typeof ReadResponseSchema>;

/** A located question after converting box_2d to our [x0, y0, x1, y1] 0-1 convention. */
export interface LocatedQuestion {
  number: string | null;
  bbox: [number, number, number, number];
  column: 1 | 2;
  type_guess: z.infer<typeof QuestionType>;
  option_count: number;
  has_diagram: boolean;
  continues_from_previous: boolean;
  continues_to_next: boolean;
}

export interface QuestionFlags {
  duplicate_number: boolean;
  sequence_gap: boolean;
  /** The reading model failed on this crop; text/options are empty. */
  unread?: boolean;
  /** The reading model returned a different number of options than the layout model counted. */
  options_mismatch?: boolean;
}

/** Stored shape in pages.ai_result, after cleanup.ts, snap.ts and reading have run. */
export interface AiQuestion extends LocatedQuestion {
  text: string;
  options: string[] | null;
  bboxRaw: [number, number, number, number];
  bboxSnapped: [number, number, number, number];
  flags: QuestionFlags;
}

export interface AiResult {
  model: string;
  columns: 1 | 2;
  questions: AiQuestion[];
}

/**
 * Stored shape in pages.ai_progress while a page is part-way through: the
 * layout is done, and text === null marks a question not read yet. Lets a
 * page that hits a rate limit resume where it stopped instead of re-running
 * the layout call. Never shown to the review screen (that only reads ai_result).
 */
export interface AiProgress {
  layoutModel: string;
  columns: 1 | 2;
  questions: (Omit<AiQuestion, "text"> & { text: string | null })[];
}
