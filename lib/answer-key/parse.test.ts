import { describe, expect, it } from "vitest";
import { describeParsed, parseAnswer, type ParsedAnswer } from "./parse";

const opts = (options: string[], flags: ParsedAnswer["flags"] = []): ParsedAnswer => ({
  options,
  numericMin: null,
  numericMax: null,
  text: null,
  flags,
});
const num = (min: number, max = min, flags: ParsedAnswer["flags"] = []): ParsedAnswer => ({
  options: null,
  numericMin: min,
  numericMax: max,
  text: null,
  flags,
});

describe("parseAnswer — options", () => {
  it.each([
    ["(c)", ["c"]],
    ["c", ["c"]],
    ["C", ["c"]],
    ["(C)", ["c"]],
    ["(a, c)", ["a", "c"]],
    ["(a; c)", ["a", "c"]],
    ["(a) and (c)", ["a", "c"]],
    ["a,c", ["a", "c"]],
    ["c, a", ["a", "c"]],
    ["Both (a) and (b)", ["a", "b"]],
    ["(a) & (d)", ["a", "d"]],
    ["(b) or (c)", ["b", "c"]],
    ["(e)", ["e"]],
    ["Ans. (c)", ["c"]],
    ["Ans: b", ["b"]],
    ["(c).", ["c"]],
    ["(a, a)", ["a"]],
  ])("%s → %j", (raw, expected) => {
    expect(parseAnswer(raw)).toEqual(opts(expected));
  });

  it("does not read a letter outside a–e as an option", () => {
    expect(parseAnswer("(f)").flags).toEqual(["unparsed"]);
  });
});

describe("parseAnswer — digit options", () => {
  it.each([
    ["(1)", "a", 1],
    ["(2)", "b", 2],
    ["(3)", "c", 3],
    ["(4)", "d", 4],
  ])("%s keeps both readings: option %s and number %d, flagged", (raw, letter, n) => {
    expect(parseAnswer(raw)).toEqual({ options: [letter], numericMin: n, numericMax: n, text: null, flags: ["digit_option"] });
  });

  it("reads several digit options", () => {
    expect(parseAnswer("(1) and (3)")).toEqual(opts(["a", "c"], ["digit_option"]));
    expect(parseAnswer("(4), (2)")).toEqual(opts(["b", "d"], ["digit_option"]));
  });

  it("treats (5) and above as a number only, as on real keys like 2. (5)", () => {
    expect(parseAnswer("(5)")).toEqual(num(5));
    expect(parseAnswer("(19)")).toEqual(num(19));
    expect(parseAnswer("(0)")).toEqual(num(0));
  });

  it("treats a bare digit as a number, not an option", () => {
    expect(parseAnswer("3")).toEqual(num(3));
  });
});

describe("parseAnswer — numbers", () => {
  it.each([
    ["4.5", 4.5],
    ["-0.25", -0.25],
    ["−0.25", -0.25],
    ["+2", 2],
    [".5", 0.5],
    ["Ans. 12", 12],
    ["Answer: 7", 7],
    ["(4.5)", 4.5],
  ])("%s → %d", (raw, n) => {
    expect(parseAnswer(raw)).toEqual(num(n));
  });

  it.each([
    ["4.4 to 4.6"],
    ["4.4-4.6"],
    ["4.4 – 4.6"],
    ["4.4—4.6"],
    ["4.4 ~ 4.6"],
    ["(4.4 to 4.6)"],
    ["Ans. 4.4 to 4.6"],
  ])("%s → range 4.4..4.6", (raw) => {
    expect(parseAnswer(raw)).toEqual(num(4.4, 4.6));
  });

  it("reads negative ranges", () => {
    expect(parseAnswer("-1 to -0.5")).toEqual(num(-1, -0.5));
  });

  it("stores a high-to-low range low-to-high and flags it", () => {
    expect(parseAnswer("4.6 to 4.4")).toEqual(num(4.4, 4.6, ["range_swapped"]));
  });
});

describe("parseAnswer — no answer and unparseable", () => {
  it.each(["Bonus", "Dropped", "None", "BONUS", "Deleted", "Cancelled", "Marks to all", "****"])("%s → no answer", (raw) => {
    expect(parseAnswer(raw)).toEqual({ options: null, numericMin: null, numericMax: null, text: null, flags: ["no_answer"] });
  });

  it.each(["12 m/s", "4,5", "1/2", "x = 3", "(a) 2036, 2036"])("%s is kept as text and flagged", (raw) => {
    expect(parseAnswer(raw)).toEqual({ options: null, numericMin: null, numericMax: null, text: raw, flags: ["unparsed"] });
  });

  it("flags empty input as unparsed with no text", () => {
    expect(parseAnswer("   ")).toEqual({ options: null, numericMin: null, numericMax: null, text: null, flags: ["unparsed"] });
  });
});

describe("describeParsed", () => {
  it("shows both readings of a digit option", () => {
    expect(describeParsed(parseAnswer("(3)"))).toBe("c or 3");
  });
  it("shows ranges and text", () => {
    expect(describeParsed(parseAnswer("4.4-4.6"))).toBe("4.4 to 4.6");
    expect(describeParsed(parseAnswer("12 m/s"))).toBe("text: 12 m/s");
    expect(describeParsed(parseAnswer("Bonus"))).toBe("no answer (bonus/dropped)");
  });
});
