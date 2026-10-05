/**
 * The key review screen's state and rules, kept out of the component so they
 * can be tested: building the draft from the model's result, assigning
 * sections (headings, ranges, by hand), warnings, and the Save payload.
 */
import type { DraftBox } from "@/components/BoxEditor";
import { normalizeQuestionNumber } from "../number";
import { uuid } from "../uuid";
import { parseAnswer } from "./parse";
import { assignSections, isMarkerHeading, sectionForHeading } from "./sections";
import type { KeyAiResult } from "./schema";

type Box = [number, number, number, number];

export interface ShortDraft {
  id: string;
  number: string;
  sectionId: string | null;
  /** Set by hand (range or per entry): heading changes don't override it. */
  manual: boolean;
  raw: string;
  ignored: boolean;
  /** The table it was read from (for reference and section assignment); null when added by hand. */
  bbox: Box | null;
}

/** A worked-solution box. Boxes with the same number and section are parts of one solution. */
export type SolutionDraft = DraftBox & {
  sectionId: string | null;
  manual: boolean;
  ignored: boolean;
  statedAnswer: string | null;
};

export interface HeadingDraft {
  text: string;
  bbox: Box;
  sectionId: string | null;
}

export interface KeyDraft {
  columns: 1 | 2;
  /** The page's section, picked at upload; used for entries with no heading above them. */
  fallbackSectionId: string | null;
  headings: HeadingDraft[];
  regions: { bbox: Box; first: string; last: string; missing: string[] }[];
  shorts: ShortDraft[];
  solutions: SolutionDraft[];
}

const boxOf = (s: SolutionDraft): Box => [s.x0, s.y0, s.x1, s.y1];

/** Recompute the section of every entry not assigned by hand, from the headings. */
export function reassignSections(draft: KeyDraft): KeyDraft {
  const auto = <T extends { manual: boolean; sectionId: string | null }>(items: T[], boxes: (Box | null)[]): T[] => {
    const assigned = assignSections(
      boxes.map((b) => ({ bbox: b ?? [0, 0, 1, 0] })),
      draft.headings,
      draft.columns,
      draft.fallbackSectionId,
    );
    return items.map((it, i) => (it.manual ? it : { ...it, sectionId: boxes[i] ? assigned[i] : (it.sectionId ?? draft.fallbackSectionId) }));
  };
  return {
    ...draft,
    shorts: auto(draft.shorts, draft.shorts.map((s) => s.bbox)),
    solutions: auto(draft.solutions, draft.solutions.map(boxOf)),
  };
}

/** The editable draft for a page the model has read. */
export function draftFromAi(result: KeyAiResult, sections: { id: string; name: string }[], fallbackSectionId: string | null): KeyDraft {
  const draft: KeyDraft = {
    columns: result.columns,
    fallbackSectionId,
    headings: result.headings.map((h) => ({ ...h, sectionId: sectionForHeading(h.text, sections) })),
    regions: result.regions.map((r) => ({ bbox: r.bbox, first: r.first, last: r.last, missing: r.missing })),
    shorts: result.entries
      .filter((e) => e.kind === "short")
      .map((e) => ({ id: uuid(), number: e.number, sectionId: null, manual: false, raw: e.raw, ignored: false, bbox: e.bbox })),
    solutions: result.entries
      .filter((e) => e.kind === "worked")
      .map((e) => ({
        id: uuid(),
        x0: e.bbox[0],
        y0: e.bbox[1],
        x1: e.bbox[2],
        y1: e.bbox[3],
        number: e.number,
        type: "theory",
        append: false,
        text: e.raw,
        options: null,
        flags: e.flags.unread ? { unread: true } : undefined,
        sectionId: null,
        manual: false,
        ignored: false,
        statedAnswer: e.statedAnswer,
      })),
  };
  return reassignSections(draft);
}

/** An empty draft, for drawing a key by hand when the model couldn't read the page. */
export function emptyDraft(fallbackSectionId: string | null): KeyDraft {
  return { columns: 1, fallbackSectionId, headings: [], regions: [], shorts: [], solutions: [] };
}

/** Map a heading to a section (or none), and re-derive the entries under it. */
export function setHeadingSection(draft: KeyDraft, index: number, sectionId: string | null): KeyDraft {
  const headings = draft.headings.map((h, i) => (i === index ? { ...h, sectionId } : h));
  return reassignSections({ ...draft, headings });
}

/** Headings the user may need to map: everything except "ANSWERS"-style markers. */
export const namedHeadings = (draft: KeyDraft) =>
  draft.headings.map((h, index) => ({ ...h, index })).filter((h) => !isMarkerHeading(h.text));

const asInt = (n: string) => {
  const v = Number(normalizeQuestionNumber(n));
  return Number.isInteger(v) ? v : null;
};

/** Put every entry numbered from..to (both kinds) in a section, by hand. */
export function setSectionForRange(draft: KeyDraft, from: string, to: string, sectionId: string | null): KeyDraft {
  const a = asInt(from);
  const b = asInt(to);
  if (a === null || b === null) return draft;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const inRange = (n: string) => {
    const v = asInt(n);
    return v !== null && v >= lo && v <= hi;
  };
  return {
    ...draft,
    shorts: draft.shorts.map((s) => (inRange(s.number) ? { ...s, sectionId, manual: true } : s)),
    solutions: draft.solutions.map((s) => (inRange(s.number) ? { ...s, sectionId, manual: true } : s)),
  };
}

export interface SolutionGroup {
  /** The first box's id; becomes the saved entry's id. */
  id: string;
  number: string;
  sectionId: string | null;
  ignored: boolean;
  text: string;
  statedAnswer: string | null;
  unread: boolean;
  boxes: SolutionDraft[];
}

/** Boxes with the same number and section form one solution; parts keep their order. */
export function groupSolutions(solutions: SolutionDraft[]): SolutionGroup[] {
  const groups = new Map<string, SolutionGroup>();
  for (const s of solutions) {
    const key = `${s.sectionId ?? ""}|${normalizeQuestionNumber(s.number)}`;
    const g = groups.get(key);
    if (g) {
      g.boxes.push(s);
      if (!g.text.trim() && s.text.trim()) g.text = s.text;
    } else {
      groups.set(key, {
        id: s.id,
        number: s.number.trim(),
        sectionId: s.sectionId,
        ignored: s.ignored,
        text: s.text,
        statedAnswer: s.statedAnswer,
        unread: !!s.flags?.unread,
        boxes: [s],
      });
    }
  }
  return [...groups.values()];
}

/** Why an entry needs a look, in plain words. Ignored entries have none. */
export function keyWarnings(draft: KeyDraft): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, msg: string) => out.set(id, [...(out.get(id) ?? []), msg]);

  const shortKeys = new Map<string, number>();
  for (const s of draft.shorts) {
    if (s.ignored) continue;
    const k = `${s.sectionId ?? ""}|${normalizeQuestionNumber(s.number)}`;
    shortKeys.set(k, (shortKeys.get(k) ?? 0) + 1);
  }

  for (const s of draft.shorts) {
    if (s.ignored) continue;
    if (!normalizeQuestionNumber(s.number)) add(s.id, "Needs a question number.");
    if (!s.sectionId) add(s.id, "Choose a section.");
    if ((shortKeys.get(`${s.sectionId ?? ""}|${normalizeQuestionNumber(s.number)}`) ?? 0) > 1) {
      add(s.id, "This number appears twice in this section. Fix one, or ignore one — neither is matched until then.");
    }
    const p = parseAnswer(s.raw);
    if (p.flags.includes("unparsed")) add(s.id, "Couldn't read this as an option or a number; it's kept as text.");
    if (p.flags.includes("digit_option")) {
      add(s.id, `Read as option ${p.options?.join(", ")} — on a numerical question it's used as the number instead. Check this.`);
    }
    if (p.flags.includes("no_answer")) add(s.id, "The key gives no answer here (bonus/dropped).");
    if (p.flags.includes("range_swapped")) add(s.id, "The range was written high-to-low; it's saved low-to-high.");
  }

  for (const g of groupSolutions(draft.solutions)) {
    if (g.ignored) continue;
    if (!normalizeQuestionNumber(g.number)) add(g.id, "Needs a question number.");
    if (!g.sectionId) add(g.id, "Choose a section.");
    if (g.unread && !g.text.trim()) add(g.id, "Couldn't read this solution's text. Its image is still saved.");
  }
  return out;
}

/** Table-level warnings: numbers missing from a table after the re-read. */
export function regionWarnings(draft: KeyDraft): string[] {
  const have = new Set(draft.shorts.map((s) => normalizeQuestionNumber(s.number)));
  return draft.regions
    .map((r) => ({ r, missing: r.missing.filter((n) => !have.has(normalizeQuestionNumber(n))) }))
    .filter(({ missing }) => missing.length)
    .map(({ r, missing }) => `Answers ${r.first}–${r.last}: couldn't read ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"} with "+ Entry".`);
}

/** Problems that block saving: a kept entry needs a number and a section. */
export function saveBlockers(draft: KeyDraft): string | null {
  const shortBad = draft.shorts.filter((s) => !s.ignored && (!normalizeQuestionNumber(s.number) || !s.sectionId));
  const solBad = groupSolutions(draft.solutions).filter((g) => !g.ignored && (!normalizeQuestionNumber(g.number) || !g.sectionId));
  const bad = [...shortBad.map((s) => s.number || "?"), ...solBad.map((g) => g.number || "?")];
  if (!bad.length) return null;
  return `Give every entry a number and a section (or ignore it): ${[...new Set(bad)].join(", ")}.`;
}

/** The body for POST /api/pages/:id/save-key. */
export function saveEntries(draft: KeyDraft) {
  return [
    ...draft.shorts.map((s) => ({
      id: s.id,
      kind: "short" as const,
      number: s.number.trim(),
      sectionId: s.sectionId,
      raw: s.raw,
      ignored: s.ignored,
      boxes: [],
      bbox: s.bbox,
    })),
    ...groupSolutions(draft.solutions).map((g) => ({
      id: g.id,
      kind: "worked" as const,
      number: g.number,
      sectionId: g.sectionId,
      raw: g.text,
      ignored: g.ignored,
      boxes: g.boxes.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 })),
      bbox: null,
    })),
  ];
}
