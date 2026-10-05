import { MIN_H, type DraftBox } from "@/components/BoxEditor";
import type { AiResult } from "./segment/schema";
import { uuid } from "./uuid";

/**
 * Split a box into two at fraction `t` (0-1) of its height. The top half
 * keeps the original id; the bottom half gets a new id, a blank number
 * (the save-time "every box needs a number" check already blocks saving
 * otherwise), and no text/options (there's no per-line bbox to split
 * against, so guessing would silently produce garbage half the time).
 * The bottom half is spliced immediately after the top half, preserving
 * "array order = reading order", which groupBoxes and the draft rely on.
 */
export function splitBox(boxes: DraftBox[], boxId: string, t: number): DraftBox[] {
  const idx = boxes.findIndex((b) => b.id === boxId);
  if (idx === -1) return boxes;
  const orig = boxes[idx];
  const gap = 0.004;
  const splitY = orig.y0 + t * (orig.y1 - orig.y0);

  const top: DraftBox = { ...orig, y1: Math.max(orig.y0 + MIN_H, splitY - gap / 2), bboxRaw: undefined, flags: undefined };
  const bottom: DraftBox = {
    ...orig,
    id: uuid(),
    y0: Math.min(orig.y1 - MIN_H, splitY + gap / 2),
    number: "",
    append: false,
    text: "",
    options: null,
    bboxRaw: undefined,
    flags: undefined,
  };

  return [...boxes.slice(0, idx), top, bottom, ...boxes.slice(idx + 1)];
}

/** First non-empty text wins, in current (reading) order. */
export function mergedText(group: DraftBox[]): string {
  return group.find((b) => b.text.trim())?.text ?? "";
}

/** First non-empty options list wins, in current (reading) order. */
export function mergedOptions(group: DraftBox[]): string[] | null {
  return group.find((b) => b.options && b.options.length)?.options ?? null;
}

/**
 * The question a page's first block continues: the previous page's last
 * question (reading order), if the model marked it continues_to_next.
 * Null when there's no previous page, it wasn't read by the model, or its
 * last question didn't run over.
 */
export function continuationTarget(previousPage: { ai_result: AiResult | null } | null): string | null {
  const questions = previousPage?.ai_result?.questions ?? [];
  const last = questions[questions.length - 1];
  return last?.continues_to_next && last.number ? last.number : null;
}

/**
 * Turn a stored AI result into editable boxes. An un-numbered block that
 * continues the previous question takes that question's number when the
 * previous question is on this page (e.g. the top of the right column), so
 * the same-number rule joins them as parts. Only the page's first block
 * can continue from an earlier page; that's resolved separately, against
 * the previous page (see continuationTarget).
 */
export function boxesFromAi(ai: AiResult, useSnapped: boolean): DraftBox[] {
  const boxes: DraftBox[] = [];
  for (const q of ai.questions) {
    const [x0, y0, x1, y1] = useSnapped ? q.bboxSnapped : q.bboxRaw;
    const previous = boxes[boxes.length - 1];
    const inherits = q.continues_from_previous && !q.number && previous;
    boxes.push({
      id: uuid(),
      x0,
      y0,
      x1,
      y1,
      number: inherits ? previous.number : (q.number ?? ""),
      type: inherits ? previous.type : q.type_guess,
      append: false,
      text: q.text,
      options: q.type_guess === "mcq" || q.type_guess === "msq" ? q.options : null,
      bboxRaw: q.bboxRaw,
      flags: {
        duplicateNumber: q.flags.duplicate_number,
        sequenceGap: q.flags.sequence_gap,
        continuesFromPrevious: q.continues_from_previous && !previous,
        unread: q.flags.unread,
        optionsMismatch: q.flags.options_mismatch,
      },
    });
  }
  return boxes;
}
