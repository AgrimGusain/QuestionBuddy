import { describe, expect, it } from "vitest";
import { cleanupQuestions } from "./cleanup";
import type { LocatedQuestion } from "./schema";

function q(partial: Partial<LocatedQuestion>): LocatedQuestion {
  return {
    number: null,
    bbox: [0, 0, 1, 1],
    column: 1,
    type_guess: "mcq",
    option_count: 0,
    has_diagram: false,
    continues_from_previous: false,
    continues_to_next: false,
    ...partial,
  };
}

function response(questions: LocatedQuestion[]): LocatedQuestion[] {
  return questions;
}

describe("cleanupQuestions", () => {
  it("clamps an out-of-range bbox", () => {
    const [out] = cleanupQuestions(response([q({ number: "1", bbox: [-0.1, 0, 1.4, 0.5] })]));
    expect(out.bbox).toEqual([0, 0, 1, 0.5]);
  });

  it("swaps a reversed bbox", () => {
    const [out] = cleanupQuestions(response([q({ number: "1", bbox: [0.6, 0.5, 0.2, 0.1] })]));
    expect(out.bbox).toEqual([0.2, 0.1, 0.6, 0.5]);
  });

  it("drops a question whose bbox area is below 1%", () => {
    const out = cleanupQuestions(response([q({ number: "1", bbox: [0, 0, 0.05, 0.05] })]));
    expect(out).toHaveLength(0);
  });

  it("sorts by column then y0 into reading order", () => {
    const out = cleanupQuestions(
      response([
        q({ number: "3", column: 2, bbox: [0, 0.1, 1, 0.3] }),
        q({ number: "1", column: 1, bbox: [0, 0.4, 1, 0.6] }),
        q({ number: "2", column: 1, bbox: [0, 0.1, 1, 0.3] }),
      ]),
    );
    expect(out.map((o) => o.number)).toEqual(["2", "1", "3"]);
  });

  it("flags duplicate numbers on the same page", () => {
    const out = cleanupQuestions(
      response([q({ number: "58", bbox: [0, 0, 1, 0.1] }), q({ number: "Q58", bbox: [0, 0.2, 1, 0.3] })]),
    );
    expect(out.map((o) => o.flags.duplicate_number)).toEqual([true, true]);
  });

  it("flags a sequence gap", () => {
    const out = cleanupQuestions(
      response([
        q({ number: "58", bbox: [0, 0, 1, 0.1] }),
        q({ number: "59", bbox: [0, 0.2, 1, 0.3] }),
        q({ number: "61", bbox: [0, 0.4, 1, 0.5] }),
      ]),
    );
    expect(out.map((o) => o.flags.sequence_gap)).toEqual([false, false, true]);
  });

  it("does not flag a gap on a continues_from_previous block", () => {
    const out = cleanupQuestions(
      response([
        q({ number: "58", bbox: [0, 0, 1, 0.1] }),
        q({ number: null, bbox: [0, 0.2, 1, 0.3], continues_from_previous: true }),
      ]),
    );
    expect(out.map((o) => o.flags.sequence_gap)).toEqual([false, false]);
  });
});
