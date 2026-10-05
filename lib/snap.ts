import sharp from "sharp";

export interface SnapInput {
  bbox: [number, number, number, number];
  column: 1 | 2;
}

const SCAN_WIDTH = 800;
const GUTTER_SNAP_TOLERANCE = 0.02; // fraction of page width
const ROW_WINDOW = 0.03; // ±3% of page height, per spec
const PADDING = 0.01; // ~1%, display padding — separate from the save route's own crop padding

export function binarize(grey: Buffer): Uint8Array {
  let sum = 0;
  for (let i = 0; i < grey.length; i++) sum += grey[i];
  const threshold = (sum / grey.length) * 0.85; // ink is noticeably darker than the page average
  const ink = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i++) ink[i] = grey[i] < threshold ? 1 : 0;
  return ink;
}

/** Sum of ink pixels per row ("row") or per column ("col"); row profiles can be restricted to an x range. */
export function computeProjection(
  ink: Uint8Array,
  width: number,
  height: number,
  axis: "row" | "col",
  xRange?: [number, number],
): number[] {
  if (axis === "col") {
    const profile = new Array(width).fill(0);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = 0; y < height; y++) sum += ink[y * width + x];
      profile[x] = sum;
    }
    return profile;
  }
  const [xStart, xEnd] = xRange ?? [0, width];
  const profile = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = xStart; x < xEnd; x++) sum += ink[y * width + x];
    profile[y] = sum;
  }
  return profile;
}

/** Center index of the widest run of near-empty entries in [from, to), or null if none. */
export function findWhitespaceGap(profile: number[], from: number, to: number, maxInk = 0): number | null {
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = from; i <= to; i++) {
    const isGap = i < to && profile[i] <= maxInk;
    if (isGap) {
      if (curStart === -1) curStart = i;
      curLen++;
    } else {
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
      curStart = -1;
      curLen = 0;
    }
  }
  return bestLen > 0 ? bestStart + Math.floor(bestLen / 2) : null;
}

/**
 * Center of the near-empty run closest to `center`, searching no further than
 * [from, to). If `center` already sits in whitespace, that run is the answer,
 * so an edge that's already clean barely moves; an edge cutting through a
 * line moves to the nearer side of it. Null if no run is in the window.
 */
export function findNearestGap(profile: number[], center: number, from: number, to: number, maxInk = 0): number | null {
  const lo = Math.max(0, from);
  const hi = Math.min(profile.length, to);
  const isGap = (i: number) => i >= lo && i < hi && profile[i] <= maxInk;
  const c = Math.min(Math.max(center, lo), hi - 1);
  let hit = -1;
  for (let d = 0; c - d >= lo || c + d < hi; d++) {
    if (isGap(c - d)) {
      hit = c - d;
      break;
    }
    if (isGap(c + d)) {
      hit = c + d;
      break;
    }
  }
  if (hit === -1) return null;
  let start = hit;
  let end = hit;
  while (isGap(start - 1)) start--;
  while (isGap(end + 1)) end++;
  return Math.floor((start + end) / 2);
}

/** Center index of the column gutter: the widest near-empty run in the middle third of the page width. */
export function findColumnGutter(profile: number[], width: number): number | null {
  const from = Math.floor(width / 3);
  const to = Math.ceil((width * 2) / 3);
  const maxInk = Math.ceil(profile.reduce((a, b) => Math.max(a, b), 0) * 0.02);
  return findWhitespaceGap(profile, from, to, maxInk);
}

function resolveOverlaps(
  snapped: [number, number, number, number][],
  questions: SnapInput[],
  ink: Uint8Array,
  width: number,
  height: number,
): void {
  const byColumn = new Map<number, number[]>();
  questions.forEach((q, i) => {
    const arr = byColumn.get(q.column) ?? [];
    arr.push(i);
    byColumn.set(q.column, arr);
  });

  for (const indices of byColumn.values()) {
    indices.sort((a, b) => snapped[a][1] - snapped[b][1]);
    for (let i = 0; i + 1 < indices.length; i++) {
      const cur = snapped[indices[i]];
      const next = snapped[indices[i + 1]];
      if (cur[3] <= next[1]) continue; // no overlap

      const xStart = Math.max(0, Math.round(Math.min(cur[0], next[0]) * width));
      const xEnd = Math.min(width, Math.round(Math.max(cur[2], next[2]) * width));
      const rowProfile = computeProjection(ink, width, height, "row", [xStart, xEnd]);
      const from = Math.round(next[1] * height);
      const to = Math.round(cur[3] * height);
      const maxInk = Math.ceil((xEnd - xStart) * 0.02);
      const gap = from < to ? findNearestGap(rowProfile, Math.round((from + to) / 2), from, to, maxInk) : null;
      const splitY = gap !== null ? gap / height : (next[1] + cur[3]) / 2;

      cur[3] = splitY;
      next[1] = splitY;
    }
  }
}

/**
 * Close gaps between consecutive questions in the same column by extending
 * each box down to where the next one starts. A question runs until the next
 * one begins, so anything between two boxes (a trailing option or a marks
 * line the model clipped) belongs to the one above; without this it would
 * end up in neither crop. Runs after overlaps are resolved, so boxes stay
 * non-overlapping.
 */
export function fillColumnGaps(boxes: [number, number, number, number][], questions: SnapInput[]): void {
  const byColumn = new Map<number, number[]>();
  questions.forEach((q, i) => byColumn.set(q.column, [...(byColumn.get(q.column) ?? []), i]));
  for (const indices of byColumn.values()) {
    indices.sort((a, b) => boxes[a][1] - boxes[b][1]);
    for (let i = 0; i + 1 < indices.length; i++) {
      const cur = boxes[indices[i]];
      const next = boxes[indices[i + 1]];
      if (cur[3] < next[1]) cur[3] = next[1];
    }
  }
}

/** Snap raw AI boxes to clean edges using projection profiles on a binarized copy of the page. */
export async function snapBoxes(
  image: Buffer,
  questions: SnapInput[],
  columns: 1 | 2,
): Promise<[number, number, number, number][]> {
  const { data, info } = await sharp(image)
    .resize({ width: SCAN_WIDTH, withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const ink = binarize(data);

  const colProfile = columns === 2 ? computeProjection(ink, width, height, "col") : null;
  const gutterIdx = colProfile ? findColumnGutter(colProfile, width) : null;
  const gutterX = gutterIdx !== null ? gutterIdx / width : null;

  const snapped = questions.map((q): [number, number, number, number] => {
    let [x0, y0, x1, y1] = q.bbox;

    if (gutterX !== null) {
      if (Math.abs(x1 - gutterX) <= GUTTER_SNAP_TOLERANCE) x1 = gutterX;
      if (Math.abs(x0 - gutterX) <= GUTTER_SNAP_TOLERANCE) x0 = gutterX;
    }

    const xStart = Math.max(0, Math.round(x0 * width));
    const xEnd = Math.min(width, Math.round(x1 * width));
    const rowProfile = computeProjection(ink, width, height, "row", [xStart, xEnd]);
    const maxInk = Math.ceil((xEnd - xStart) * 0.02);
    const windowPx = Math.round(ROW_WINDOW * height);

    const y0Idx = Math.round(y0 * height);
    const topGap = findNearestGap(rowProfile, y0Idx, y0Idx - windowPx, y0Idx + windowPx, maxInk);
    if (topGap !== null) y0 = topGap / height;

    const y1Idx = Math.round(y1 * height);
    const botGap = findNearestGap(rowProfile, y1Idx, y1Idx - windowPx, y1Idx + windowPx, maxInk);
    if (botGap !== null) y1 = botGap / height;

    return [x0, y0, x1, y1];
  });

  const padded = snapped.map(
    ([x0, y0, x1, y1]): [number, number, number, number] => [
      Math.max(0, x0 - PADDING),
      Math.max(0, y0 - PADDING),
      Math.min(1, x1 + PADDING),
      Math.min(1, y1 + PADDING),
    ],
  );

  // Resolved last, after padding, so the final output is guaranteed non-overlapping.
  resolveOverlaps(padded, questions, ink, width, height);
  fillColumnGaps(padded, questions);

  return padded;
}
