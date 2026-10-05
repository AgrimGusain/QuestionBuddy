import { describe, expect, it } from "vitest";
import type { DraftBox } from "@/components/BoxEditor";
import { boxesFromAi, continuationTarget, mergedOptions, mergedText, splitBox } from "./review";
import type { AiQuestion, AiResult } from "./segment/schema";

function aiQ(partial: Partial<AiQuestion>): AiQuestion {
  return {
    number: "1",
    bbox: [0, 0, 1, 0.2],
    bboxRaw: [0, 0, 1, 0.2],
    bboxSnapped: [0.01, 0.01, 0.99, 0.21],
    column: 1,
    type_guess: "mcq",
    option_count: 0,
    text: "",
    options: null,
    has_diagram: false,
    continues_from_previous: false,
    continues_to_next: false,
    flags: { duplicate_number: false, sequence_gap: false },
    ...partial,
  };
}

function ai(questions: AiQuestion[]): AiResult {
  return { model: "m", columns: 2, questions };
}

function box(partial: Partial<DraftBox>): DraftBox {
  return {
    id: "a",
    x0: 0,
    y0: 0.2,
    x1: 1,
    y1: 0.6,
    number: "1",
    type: "mcq",
    append: false,
    text: "",
    options: null,
    ...partial,
  };
}

describe("splitBox", () => {
  it("keeps the original id on the top half and inserts the bottom half right after it", () => {
    const boxes = [box({ id: "a", y0: 0.2, y1: 0.6 }), box({ id: "z", y0: 0.7, y1: 0.9 })];
    const out = splitBox(boxes, "a", 0.5);
    expect(out.map((b) => b.id)).toEqual(["a", out[1].id, "z"]);
    expect(out[1].id).not.toBe("a");
  });

  it("gives the bottom half a blank number and no text/options", () => {
    const boxes = [box({ text: "stem", options: ["x", "y"] })];
    const [top, bottom] = splitBox(boxes, "a", 0.5);
    expect(top.text).toBe("stem");
    expect(bottom.number).toBe("");
    expect(bottom.text).toBe("");
    expect(bottom.options).toBeNull();
  });

  it("returns the boxes unchanged when the id isn't found", () => {
    const boxes = [box({})];
    expect(splitBox(boxes, "missing", 0.5)).toBe(boxes);
  });
});

describe("mergedText / mergedOptions", () => {
  it("first non-empty text wins", () => {
    const group = [box({ text: "" }), box({ id: "b", text: "the real text" })];
    expect(mergedText(group)).toBe("the real text");
  });

  it("first non-empty options wins", () => {
    const group = [box({ options: null }), box({ id: "b", options: ["a", "b"] })];
    expect(mergedOptions(group)).toEqual(["a", "b"]);
  });

  it("returns empty/null when nothing is set", () => {
    const group = [box({}), box({ id: "b" })];
    expect(mergedText(group)).toBe("");
    expect(mergedOptions(group)).toBeNull();
  });
});

describe("continuationTarget", () => {
  it("returns the previous page's last question when it runs over", () => {
    const prev = { ai_result: ai([aiQ({ number: "8" }), aiQ({ number: "9", continues_to_next: true })]) };
    expect(continuationTarget(prev)).toBe("9");
  });

  it("returns null when the previous page's last question doesn't run over", () => {
    const prev = { ai_result: ai([aiQ({ number: "9", continues_to_next: false })]) };
    expect(continuationTarget(prev)).toBeNull();
  });

  it("returns null with no previous page or no AI result on it", () => {
    expect(continuationTarget(null)).toBeNull();
    expect(continuationTarget({ ai_result: null })).toBeNull();
  });
});

describe("boxesFromAi", () => {
  it("uses snapped or raw boxes depending on the display setting", () => {
    const result = ai([aiQ({})]);
    expect(boxesFromAi(result, true)[0].x0).toBe(0.01);
    expect(boxesFromAi(result, false)[0].x0).toBe(0);
  });

  it("joins a same-page continuation to the previous question by number", () => {
    const result = ai([
      aiQ({ number: "58", column: 1 }),
      aiQ({ number: null, column: 2, continues_from_previous: true }),
    ]);
    const boxes = boxesFromAi(result, true);
    expect(boxes[1].number).toBe("58");
    expect(boxes[1].append).toBe(false);
    expect(boxes[1].flags?.continuesFromPrevious).toBe(false);
  });

  it("flags only the page's first block as continuing from an earlier page", () => {
    const result = ai([aiQ({ number: null, continues_from_previous: true }), aiQ({ number: "10" })]);
    const boxes = boxesFromAi(result, true);
    expect(boxes[0].number).toBe("");
    expect(boxes[0].flags?.continuesFromPrevious).toBe(true);
  });

  it("drops options for non-choice question types", () => {
    const result = ai([aiQ({ type_guess: "numerical", options: ["1", "2"] })]);
    expect(boxesFromAi(result, true)[0].options).toBeNull();
  });
});
