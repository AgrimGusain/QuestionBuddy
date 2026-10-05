/**
 * Splitting a big short-answer table into pieces small enough for one
 * reading call, and checking afterwards that every number came back.
 *
 * Measured (session 3, a 36-entry key): ~15 output tokens per entry; read
 * whole, every entry came back; cut blindly at the middle, 6 of 36 went
 * missing. So tables are split only when too big, and only at the whitespace
 * between rows of entries.
 */
import sharp from "sharp";
import { normalizeQuestionNumber } from "../number";
import { binarize, computeProjection, findNearestGap } from "../snap";

/** Above this many expected entries a table is read in pieces. */
export const MAX_ENTRIES_PER_CALL = 45;
export const MAX_ROWS_PER_CHUNK = 3;
const SCAN_WIDTH = 800;

/** How many entries a table should hold: the number span when both ends are integers, else rows × columns. */
export function expectedEntries(region: { rows: number; columns: number; first: string; last: string }): number {
  const a = Number(normalizeQuestionNumber(region.first));
  const b = Number(normalizeQuestionNumber(region.last));
  if (Number.isInteger(a) && Number.isInteger(b) && b >= a && b - a < 1000) return b - a + 1;
  return Math.max(1, region.rows * region.columns);
}

/** Numbers between first and last (inclusive, integers only) that were not read. */
export function missingNumbers(first: string, last: string, read: string[]): string[] {
  const a = Number(normalizeQuestionNumber(first));
  const b = Number(normalizeQuestionNumber(last));
  if (!Number.isInteger(a) || !Number.isInteger(b) || b < a || b - a > 500) return [];
  const seen = new Set(read.map(normalizeQuestionNumber));
  const missing: string[] = [];
  for (let n = a; n <= b; n++) if (!seen.has(String(n))) missing.push(String(n));
  return missing;
}

/** Runs of inked rows (text lines) in a row profile, as [start, end) index pairs. */
export function findLines(profile: number[], maxInk: number): [number, number][] {
  const lines: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= profile.length; i++) {
    const ink = i < profile.length && profile[i] > maxInk;
    if (ink && start === -1) start = i;
    if (!ink && start !== -1) {
      lines.push([start, i]);
      start = -1;
    }
  }
  // Specks above/below a line (dots, descenders) show up as tiny runs: drop them.
  const tallest = Math.max(0, ...lines.map(([s, e]) => e - s));
  return lines.filter(([s, e]) => e - s >= tallest * 0.3);
}

/**
 * Where to cut a table of `rows` rows into pieces of at most `maxRows` rows,
 * as [start, end) ranges over the profile. When the text lines found match
 * the row count, cuts go midway between lines; otherwise the table is cut
 * into equal bands with each cut moved to the nearest whitespace.
 */
export function planChunkRanges(profile: number[], maxInk: number, rows: number, maxRows = MAX_ROWS_PER_CHUNK): [number, number][] {
  const n = profile.length;
  const pieces = Math.ceil(rows / maxRows);
  if (pieces <= 1 || n === 0) return [[0, n]];

  const lines = findLines(profile, maxInk);
  const cuts: number[] = [];
  if (lines.length === rows) {
    for (let r = maxRows; r < rows; r += maxRows) cuts.push(Math.round((lines[r - 1][1] + lines[r][0]) / 2));
  } else {
    const band = n / pieces;
    for (let k = 1; k < pieces; k++) {
      const target = Math.round(k * band);
      cuts.push(findNearestGap(profile, target, target - Math.round(band / 3), target + Math.round(band / 3), maxInk) ?? target);
    }
  }
  const edges = [0, ...cuts, n];
  return edges.slice(0, -1).map((s, i) => [s, edges[i + 1]] as [number, number]);
}

/**
 * The boxes to read a table in: the whole table when it's small enough,
 * otherwise bands split between rows. Boxes are normalized page coordinates.
 */
export async function planChunks(
  page: Buffer,
  region: { bbox: [number, number, number, number]; rows: number; columns: number; first: string; last: string },
): Promise<[number, number, number, number][]> {
  if (expectedEntries(region) <= MAX_ENTRIES_PER_CALL) return [region.bbox];

  const [x0, y0, x1, y1] = region.bbox;
  const { width = 1, height = 1 } = await sharp(page).metadata();
  const left = Math.floor(x0 * width);
  const top = Math.floor(y0 * height);
  const w = Math.max(1, Math.ceil(x1 * width) - left);
  const h = Math.max(1, Math.ceil(y1 * height) - top);
  const { data, info } = await sharp(page)
    .extract({ left, top, width: w, height: h })
    .resize({ width: SCAN_WIDTH, withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ink = binarize(data);
  const profile = computeProjection(ink, info.width, info.height, "row");
  const ranges = planChunkRanges(profile, Math.ceil(info.width * 0.02), region.rows);
  return ranges.map(([s, e]) => [x0, y0 + (s / info.height) * (y1 - y0), x1, y0 + (e / info.height) * (y1 - y0)]);
}
