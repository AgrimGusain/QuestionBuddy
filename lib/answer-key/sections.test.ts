import { describe, expect, it } from "vitest";
import { assignSections, isMarkerHeading, normalizeName, sectionForHeading, type PlacedHeading } from "./sections";

const sections = [
  { id: "s1", name: "Exercise 1" },
  { id: "s2", name: "Exercise 2" },
  { id: "lv", name: "Level 2 (Advanced)" },
  { id: "g", name: "General" },
];

describe("normalizeName", () => {
  it("ignores case, punctuation and spacing, and reads roman numerals", () => {
    expect(normalizeName("EXERCISE – II")).toBe("exercise2");
    expect(normalizeName("Exercise-1")).toBe("exercise1");
    expect(normalizeName("Hints & Solutions")).toBe("hintsandsolutions");
  });
});

describe("sectionForHeading", () => {
  it.each([
    ["Exercise 1", "s1"],
    ["EXERCISE - I", "s1"],
    ["Exercise II", "s2"],
    ["Level 2", "lv"],
  ])("%s → %s", (heading, id) => {
    expect(sectionForHeading(heading, sections)).toBe(id);
  });

  it("returns null for answer markers and unknown headings", () => {
    expect(sectionForHeading("ANSWERS", sections)).toBeNull();
    expect(sectionForHeading("EXPLANATIONS", sections)).toBeNull();
    expect(sectionForHeading("Exercise 3", sections)).toBeNull();
  });

  it("returns null when containment is ambiguous", () => {
    expect(sectionForHeading("Exercise", sections)).toBeNull();
  });
});

describe("isMarkerHeading", () => {
  it("knows the usual answer headings", () => {
    for (const h of ["ANSWERS", "Answer Key", "EXPLANATIONS", "Hints & Solutions", "Solutions"]) expect(isMarkerHeading(h)).toBe(true);
    expect(isMarkerHeading("Exercise 1")).toBe(false);
  });
});

describe("assignSections", () => {
  const h = (text: string, x0: number, y0: number, sectionId: string | null): PlacedHeading => ({ text, bbox: [x0, y0, x0 + 0.3, y0 + 0.03], sectionId });
  const e = (x0: number, y0: number) => ({ bbox: [x0, y0, x0 + 0.3, y0 + 0.05] as [number, number, number, number] });

  it("uses the nearest heading above in the same column", () => {
    const headings = [h("Exercise 1", 0.05, 0.1, "s1"), h("Exercise 2", 0.05, 0.5, "s2")];
    expect(assignSections([e(0.05, 0.2), e(0.05, 0.6)], headings, 1, "fallback")).toEqual(["s1", "s2"]);
  });

  it("carries the last left-column heading into the top of the right column", () => {
    const headings = [h("Exercise 1", 0.05, 0.1, "s1"), h("Exercise 2", 0.05, 0.7, "s2")];
    expect(assignSections([e(0.55, 0.05)], headings, 2, "fallback")).toEqual(["s2"]);
  });

  it("skips answer markers like ANSWERS", () => {
    const headings = [h("Exercise 1", 0.05, 0.1, "s1"), h("ANSWERS", 0.3, 0.4, null)];
    expect(assignSections([e(0.05, 0.5)], headings, 1, "fallback")).toEqual(["s1"]);
  });

  it("falls back to the page's section only when no heading comes before the entry", () => {
    const headings = [h("Exercise 2", 0.05, 0.5, "s2")];
    expect(assignSections([e(0.05, 0.1), e(0.05, 0.6)], headings, 1, "fallback")).toEqual(["fallback", "s2"]);
  });

  it("leaves entries under an unmapped heading unassigned, so the user decides", () => {
    const headings = [h("Level 9", 0.05, 0.1, null)];
    expect(assignSections([e(0.05, 0.2)], headings, 1, "fallback")).toEqual([null]);
  });
});
