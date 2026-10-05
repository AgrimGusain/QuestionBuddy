/**
 * Which section each answer-key entry belongs to, from the headings Gemini
 * found on the page ("Exercise 1", "Level 2", …). Pure functions: the key
 * review screen runs them, and re-runs them whenever the user maps a heading
 * to a section by hand.
 */

type Box = [number, number, number, number];

/** Headings that name a kind of answer rather than a group of questions. */
const MARKERS = new Set(["answers", "answer", "answerkey", "answerkeys", "explanations", "explanation", "solutions", "solution", "hints", "hintsandsolutions", "hintssolutions", "workedsolutions"]);

const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };

/** "Exercise – II" → "exercise2", "LEVEL 1" → "level1". */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => ROMAN[w] ?? w)
    .join("");
}

export function isMarkerHeading(text: string): boolean {
  return MARKERS.has(normalizeName(text));
}

/** The section a heading names, or null. Exact (normalized) name first, then containment either way. */
export function sectionForHeading(text: string, sections: { id: string; name: string }[]): string | null {
  const h = normalizeName(text);
  if (!h || isMarkerHeading(text)) return null;
  const exact = sections.find((s) => normalizeName(s.name) === h);
  if (exact) return exact.id;
  const contained = sections.filter((s) => {
    const n = normalizeName(s.name);
    return n.length >= 3 && (h.includes(n) || n.includes(h));
  });
  return contained.length === 1 ? contained[0].id : null;
}

export interface PlacedHeading {
  bbox: Box;
  text: string;
  /** The section the user or sectionForHeading mapped it to; null = unknown. */
  sectionId: string | null;
}

/** Reading-order key: column first (left column, then right), then top edge. */
function position(bbox: Box, columns: 1 | 2): [number, number] {
  const column = columns === 2 && bbox[0] >= 0.45 ? 2 : 1;
  return [column, bbox[1]];
}

/**
 * Section for each entry: the nearest heading before it in reading order
 * decides. Marker headings ("ANSWERS") are skipped. A heading the app can't
 * map gives null (the user must choose), not the fallback: the fallback is
 * only for entries with no heading before them at all.
 */
export function assignSections(
  entries: { bbox: Box }[],
  headings: PlacedHeading[],
  columns: 1 | 2,
  fallbackSectionId: string | null,
): (string | null)[] {
  const named = headings
    .filter((h) => !isMarkerHeading(h.text))
    .map((h) => ({ ...h, pos: position(h.bbox, columns) }))
    .sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);

  return entries.map((e) => {
    const [col, y] = position(e.bbox, columns);
    let found: (typeof named)[number] | null = null;
    for (const h of named) {
      const before = h.pos[0] < col || (h.pos[0] === col && h.pos[1] <= y + 0.005);
      if (before) found = h;
    }
    return found ? found.sectionId : fallbackSectionId;
  });
}
