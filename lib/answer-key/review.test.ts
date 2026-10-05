import { describe, expect, it } from "vitest";
import {
  draftFromAi,
  groupSolutions,
  keyWarnings,
  regionWarnings,
  saveBlockers,
  saveEntries,
  setHeadingSection,
  setSectionForRange,
  type KeyDraft,
} from "./review";
import type { KeyAiResult } from "./schema";

const sections = [
  { id: "s1", name: "Exercise 1" },
  { id: "s2", name: "Exercise 2" },
];

function result(partial: Partial<KeyAiResult> = {}): KeyAiResult {
  return {
    kind: "answer_key",
    model: "m",
    columns: 1,
    headings: [
      { text: "Exercise 1", bbox: [0.05, 0.05, 0.4, 0.08] },
      { text: "Exercise 2", bbox: [0.05, 0.5, 0.4, 0.53] },
    ],
    regions: [{ bbox: [0.05, 0.1, 0.95, 0.3], rows: 1, columns: 3, first: "1", last: "3", missing: ["3"] }],
    entries: [
      { number: "1", kind: "short", raw: "(a)", bbox: [0.05, 0.1, 0.95, 0.3], region: 0, statedAnswer: null, flags: {} },
      { number: "2", kind: "short", raw: "(3)", bbox: [0.05, 0.1, 0.95, 0.3], region: 0, statedAnswer: null, flags: {} },
      { number: "5", kind: "worked", raw: "", bbox: [0.05, 0.6, 0.95, 0.7], region: null, statedAnswer: null, flags: { unread: true } },
    ],
    ...partial,
  };
}

describe("draftFromAi", () => {
  it("assigns sections from the headings above each entry", () => {
    const d = draftFromAi(result(), sections, null);
    expect(d.headings.map((h) => h.sectionId)).toEqual(["s1", "s2"]);
    expect(d.shorts.map((s) => s.sectionId)).toEqual(["s1", "s1"]);
    expect(d.solutions[0].sectionId).toBe("s2");
  });

  it("falls back to the page's section when there are no headings", () => {
    const d = draftFromAi(result({ headings: [] }), sections, "s2");
    expect(d.shorts.map((s) => s.sectionId)).toEqual(["s2", "s2"]);
  });

  it("leaves entries unassigned when nothing tells which section they're in", () => {
    const d = draftFromAi(result({ headings: [{ text: "ANSWERS", bbox: [0.4, 0.02, 0.6, 0.05] }] }), sections, null);
    expect(d.shorts.map((s) => s.sectionId)).toEqual([null, null]);
  });
});

describe("section editing", () => {
  it("re-derives entries under a heading when the user maps it, but not ones set by hand", () => {
    let d = draftFromAi(result({ headings: [{ text: "Level 9", bbox: [0.05, 0.05, 0.4, 0.08] }] }), sections, null);
    expect(d.shorts.map((s) => s.sectionId)).toEqual([null, null]);
    d = setSectionForRange(d, "2", "2", "s1");
    d = setHeadingSection(d, 0, "s2");
    expect(d.shorts.map((s) => s.sectionId)).toEqual(["s2", "s1"]);
  });

  it("sets a range of entries of both kinds, in either order", () => {
    const d = setSectionForRange(draftFromAi(result(), sections, null), "5", "1", "s2");
    expect(d.shorts.every((s) => s.sectionId === "s2" && s.manual)).toBe(true);
    expect(d.solutions[0].sectionId).toBe("s2");
  });
});

describe("warnings and saving", () => {
  it("explains digit options, unread solutions and missing table numbers", () => {
    const d = draftFromAi(result(), sections, null);
    const w = keyWarnings(d);
    expect(w.get(d.shorts[1].id)?.[0]).toContain("Read as option c");
    expect(w.get(d.solutions[0].id)).toEqual(["Couldn't read this solution's text. Its image is still saved."]);
    expect(regionWarnings(d)).toEqual([`Answers 1–3: couldn't read 3. Add it with "+ Entry".`]);
  });

  it("flags the same number twice in one section, and stops once one is ignored", () => {
    const d = draftFromAi(result(), sections, null);
    const dup: KeyDraft = { ...d, shorts: [...d.shorts, { ...d.shorts[0], id: "dup" }] };
    expect(keyWarnings(dup).get("dup")?.some((m) => m.includes("twice"))).toBe(true);
    const fixed: KeyDraft = { ...dup, shorts: dup.shorts.map((s) => (s.id === "dup" ? { ...s, ignored: true } : s)) };
    expect(keyWarnings(fixed).get(d.shorts[0].id)?.some((m) => m.includes("twice"))).toBeFalsy();
  });

  it("blocks saving until every kept entry has a section", () => {
    const d = draftFromAi(result({ headings: [] }), sections, null);
    expect(saveBlockers(d)).toContain("1, 2, 5");
    const ignored: KeyDraft = { ...d, shorts: d.shorts.map((s) => ({ ...s, ignored: true })), solutions: d.solutions.map((s) => ({ ...s, ignored: true })) };
    expect(saveBlockers(ignored)).toBeNull();
  });

  it("joins solution boxes with the same number and section into one entry with several parts", () => {
    const d = draftFromAi(result(), sections, null);
    const part2 = { ...d.solutions[0], id: "p2", y0: 0.75, y1: 0.8, text: "rest" };
    const groups = groupSolutions([...d.solutions, part2]);
    expect(groups).toHaveLength(1);
    expect(groups[0].boxes).toHaveLength(2);
    expect(groups[0].text).toBe("rest");

    const otherSection = { ...part2, id: "p3", sectionId: "s1" };
    expect(groupSolutions([...d.solutions, otherSection])).toHaveLength(2);
  });

  it("builds the save body", () => {
    const d = draftFromAi(result(), sections, null);
    const body = saveEntries(d);
    expect(body).toHaveLength(3);
    expect(body[0]).toMatchObject({ kind: "short", number: "1", sectionId: "s1", raw: "(a)", boxes: [] });
    expect(body[2]).toMatchObject({ kind: "worked", number: "5", sectionId: "s2", boxes: [{ x0: 0.05, y0: 0.6, x1: 0.95, y1: 0.7 }] });
  });
});
