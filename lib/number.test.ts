import { describe, expect, it } from "vitest";
import { compareQuestionNumbers, nextQuestionNumber, normalizeQuestionNumber } from "./number";

describe("normalizeQuestionNumber (same cases as the SQL function test)", () => {
  const cases: [string, string][] = [
    ["Q58", "58"], ["Q.58", "58"], ["58.", "58"], ["(58)", "58"], [" 58 ", "58"],
    ["12(a)", "12a"], ["1.2", "1.2"], ["Q 58", "58"], ["No.7", "7"], ["#3", "3"],
    ["Quiz", "quiz"], ["q12b)", "12b"],
  ];
  it.each(cases)("%s -> %s", (input, out) => expect(normalizeQuestionNumber(input)).toBe(out));
});

describe("ordering and suggestions", () => {
  it("sorts naturally", () => {
    expect(["10", "2", "Q1", "10a"].sort(compareQuestionNumbers)).toEqual(["Q1", "2", "10", "10a"]);
  });
  it("suggests the next number", () => {
    expect(nextQuestionNumber("58")).toBe("59");
    expect(nextQuestionNumber("Q12a")).toBe("13");
    expect(nextQuestionNumber()).toBe("1");
  });
});
