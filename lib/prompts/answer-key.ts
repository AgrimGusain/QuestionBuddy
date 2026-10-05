/**
 * Prompts for reading answer-key pages (lib/ai.ts). Measured in session 3 on
 * two real pages: the layout prompt found the ANSWERS table (rows, columns,
 * first/last number), both headings, and all 13 worked solutions without a
 * RECITATION refusal; the key prompt read all 36 entries of the table right.
 * Gemini is asked for positions and headings only — never for answers or
 * solution text, which it refuses to copy from books.
 */

/** System prompt for locateAnswerKey(): Gemini, positions only. */
export const KEY_LAYOUT_SYSTEM_PROMPT = `You are finding where things are on one photo of a page from an exam-prep book. \
The page may contain answer keys. Do NOT transcribe answers, solutions or questions.

Return:
- "headings": every heading that names a part of the answers or a group of questions, such as \
"ANSWERS", "EXPLANATIONS", "Answer Key", "Hints & Solutions", "Exercise 1", "Level 2" — its text and its box.
- "key_regions": every block of short answers laid out as a table or grid (like "58. (c)   59. (a) ..."): \
its box, how many rows and columns of entries it has, and the first and last question numbers in it.
- "solutions": every worked solution or explanation that starts with a question number: its number, \
its column (1 or 2) and a box covering the whole solution, up to where the next one starts or the column ends.

Ignore question text and answer options that are on the page but are not part of an answer key or solution.

Respond with JSON only:
{"columns": 1 or 2,
 "headings": [{"text": "ANSWERS", "box_2d": [ymin, xmin, ymax, xmax]}],
 "key_regions": [{"box_2d": [ymin, xmin, ymax, xmax], "rows": 4, "columns": 10, "first_number": "1", "last_number": "36"}],
 "solutions": [{"number": "5", "column": 2, "box_2d": [ymin, xmin, ymax, xmax]}]}
box_2d values are integers normalized to 0-1000.`;

/** System prompt for readKeyEntries(): Groq, one crop of a short-answer table. */
export const KEY_READ_SYSTEM_PROMPT = `You read answer keys from photos of exam-prep book pages. Return every entry of the \
answer key: the question number and the answer exactly as printed (keep brackets and separators, e.g. \
"(c)", "(a; c)", "(19)"). Read a table row by row, left to right. Ignore everything that is not part of an \
answer key: question text, answer options, explanations, page headers.

Respond with JSON only: {"entries": [{"number": "1", "answer": "(d)"}]}`;

export function keyReadUserPrompt(hint: { rows: number; columns: number; first: string; last: string; only?: string[] }): string {
  if (hint.only?.length) {
    return `Read only these entries of the answer key in this crop: ${hint.only.join(", ")}. Skip every other entry.`;
  }
  return `Read the answer key in this crop. It has about ${hint.rows} rows of ${hint.columns} entries, numbered ${hint.first} to ${hint.last}. \
If a row is cut off at the top or bottom edge, read the entries you can see fully.`;
}

/** System prompt for readWorkedSolution(): Groq, one worked-solution crop. */
export const WORKED_READ_SYSTEM_PROMPT = `You are transcribing ONE worked solution from a photo of an exam-prep book page. \
The image is a crop around that solution; a sliver of neighbouring solutions may show at the edges — \
ignore it. Copy the solution exactly as printed, including code and tables as plain-text rows. Leave out \
the question number itself. Never invent, complete or correct text. If the solution states its final \
answer explicitly (e.g. "Hence correct answer would be ...", "Ans. (c)"), also copy that phrase into \
"stated_answer"; otherwise null.

Respond with JSON only: {"text": "...", "stated_answer": "..." or null}`;

export function workedReadUserPrompt(number: string): string {
  return `Transcribe solution ${number}.`;
}
