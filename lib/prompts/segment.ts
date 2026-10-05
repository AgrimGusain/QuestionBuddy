/**
 * Prompts for lib/ai.ts. Kept in their own file so the wording can be tuned
 * without touching the request/validation logic.
 *
 * The work is split in two because no single free model does both well:
 * Gemini locates questions precisely but refuses to transcribe copyrighted
 * book text (finishReason RECITATION), while Groq's Qwen reads text well but
 * can't place boxes (its coordinates are guesses). So Gemini only says where
 * each question is, and Qwen reads each question from its own crop.
 */

/** System prompt for locateQuestions(): layout only, never text. */
export const LAYOUT_SYSTEM_PROMPT = `You are finding where each question sits on one page \
of a textbook or exam-prep book, possibly laid out in two columns. Do NOT transcribe any text.

Reading order: left column top to bottom, then right column top to bottom. \
If the page has only one column, read top to bottom.

A new question starts at a line beginning with a question number, such as \
"58.", "Q58", "58)" or "(58)". A question's region covers its full text, code, \
tables, diagrams and figures, ALL of its answer options, and its source/marks \
line (such as "[2015 (Set-3): 2 Marks]"), up to where the next question starts \
or the column ends.

If the first block at the top of a column has no number, it continues the \
previous question: set continues_from_previous = true and number = null for \
that block. If a question is cut off at the bottom of the page (it clearly \
continues beyond the page), set continues_to_next = true.

Ignore page headers, footers, page numbers and chapter titles — do not turn \
them into questions.

Respond with JSON only, matching this exact shape:
{
  "columns": 1 or 2,
  "questions": [
    {
      "number": "58" or null,
      "column": 1 or 2,
      "box_2d": [ymin, xmin, ymax, xmax],
      "type_guess": "mcq" | "msq" | "numerical" | "theory",
      "option_count": number of printed answer options, 0 if none,
      "has_diagram": true or false,
      "continues_from_previous": true or false,
      "continues_to_next": true or false
    }
  ]
}

box_2d is the question's region as [ymin, xmin, ymax, xmax], integers \
normalized to 0-1000.`;

/** System prompt for readQuestion(): one cropped question at a time. */
export const READ_SYSTEM_PROMPT = `You are transcribing ONE question from a photo of a \
textbook or exam-prep book page. The image is a crop around that question; a \
sliver of the neighbouring questions may show at the top or bottom edge — \
ignore anything that isn't part of the question you are asked for.

Copy the question exactly as printed: its full text, including code, tables \
(as plain-text rows) and its source/marks line such as "[2015 (Set-3): 2 Marks]". \
Leave out the question number itself. Never invent, complete or correct text. \
Use LaTeX-style notation only for maths that cannot be written in plain text.

Put the answer options in "options", in order, without their (a)/(b)/(c) \
labels, and leave them out of "text". If the question has no printed options, \
use null.

Respond with JSON only: {"text": "question text", "options": ["...", "..."] or null}`;

/** User message for readQuestion(). The option count is the layout model's, used only as a hint. */
export function readUserPrompt(number: string | null, optionCount: number): string {
  const which = number ? `question ${number}` : "the question (it continues from an earlier one, so has no number)";
  const hint =
    optionCount > 0
      ? ` It appears to have ${optionCount} answer options; transcribe every one that is printed.`
      : " It appears to have no answer options.";
  return `Transcribe ${which}.${hint}`;
}
