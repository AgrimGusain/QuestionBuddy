import { describe, expect, it } from "vitest";
import { LayoutResponseSchema, ReadResponseSchema } from "./schema";

const valid = {
  columns: 2,
  questions: [
    {
      number: "58",
      column: 1,
      box_2d: [100, 50, 300, 480],
      type_guess: "mcq",
      option_count: 4,
      has_diagram: false,
      continues_from_previous: false,
      continues_to_next: false,
    },
  ],
};

describe("LayoutResponseSchema", () => {
  it("parses a valid response", () => {
    expect(LayoutResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a null number", () => {
    const q = { ...valid.questions[0], number: null };
    expect(LayoutResponseSchema.safeParse({ ...valid, questions: [q] }).success).toBe(true);
  });

  it("rejects a missing field", () => {
    const { option_count, ...rest } = valid.questions[0];
    expect(LayoutResponseSchema.safeParse({ ...valid, questions: [rest] }).success).toBe(false);
  });

  it("rejects an invalid type_guess", () => {
    const q = { ...valid.questions[0], type_guess: "essay" };
    expect(LayoutResponseSchema.safeParse({ ...valid, questions: [q] }).success).toBe(false);
  });

  it("rejects a box_2d with the wrong arity", () => {
    const q = { ...valid.questions[0], box_2d: [0, 0, 1] };
    expect(LayoutResponseSchema.safeParse({ ...valid, questions: [q] }).success).toBe(false);
  });
});

describe("ReadResponseSchema", () => {
  it("accepts text with options or with null options", () => {
    expect(ReadResponseSchema.safeParse({ text: "Q", options: ["a", "b"] }).success).toBe(true);
    expect(ReadResponseSchema.safeParse({ text: "Q", options: null }).success).toBe(true);
  });

  it("rejects missing text", () => {
    expect(ReadResponseSchema.safeParse({ options: null }).success).toBe(false);
  });
});
