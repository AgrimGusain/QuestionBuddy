import { describe, expect, it } from "vitest";
import { gradeMcq, gradeMsq, gradeNumeric, parseUserNumber } from "./grading";

describe("gradeMsq", () => {
  it("needs the exact set", () => {
    expect(gradeMsq(["a", "c"], ["c", "a"])).toBe("correct");
    expect(gradeMsq(["a"], ["a", "c"])).toBe("wrong");
    expect(gradeMsq(["a", "b", "c"], ["a", "c"])).toBe("wrong");
  });
});

describe("gradeMcq", () => {
  it("matches the stored option", () => {
    expect(gradeMcq("c", ["c"])).toBe("correct");
    expect(gradeMcq("b", ["c"])).toBe("wrong");
  });
});

describe("gradeNumeric", () => {
  it("uses ±1% when min = max", () => {
    expect(gradeNumeric(9.89, 9.8, 9.8, 1)).toBe("correct");
    expect(gradeNumeric(9.71, 9.8, 9.8, 1)).toBe("correct");
    expect(gradeNumeric(9.702, 9.8, 9.8, 1)).toBe("correct"); // exactly on the edge
    expect(gradeNumeric(9.69, 9.8, 9.8, 1)).toBe("wrong");
    expect(gradeNumeric(-2.02, -2, -2, 1)).toBe("correct");
  });
  it("needs an exact 0 when the answer is 0", () => {
    expect(gradeNumeric(0, 0, 0, 1)).toBe("correct");
    expect(gradeNumeric(0.001, 0, 0, 1)).toBe("wrong");
  });
  it("uses the range without tolerance when min < max", () => {
    expect(gradeNumeric(3.1, 3.1, 3.3)).toBe("correct");
    expect(gradeNumeric(3.3, 3.1, 3.3)).toBe("correct");
    expect(gradeNumeric(3.31, 3.1, 3.3)).toBe("wrong");
  });
});

describe("parseUserNumber", () => {
  it("accepts common inputs", () => {
    expect(parseUserNumber(" 3,5 ")).toBe(3.5);
    expect(parseUserNumber("-0.5")).toBe(-0.5);
    expect(parseUserNumber(".5")).toBe(0.5);
    expect(parseUserNumber("6e-3")).toBe(0.006);
  });
  it("rejects non-numbers", () => {
    expect(parseUserNumber("")).toBeNull();
    expect(parseUserNumber("abc")).toBeNull();
    expect(parseUserNumber("3.5m")).toBeNull();
  });
});
