/**
 * Reading one answer-key page, as the answer-key branch of the segment
 * route (app/api/pages/[pageId]/segment/route.ts):
 *   1. layout — Gemini finds headings, short-answer tables and worked
 *      solutions (positions only). Big tables are planned as row bands
 *      (chunks.ts); solution boxes are snapped like question boxes.
 *   2. reading — Qwen reads each table piece, then re-reads any numbers
 *      missing from a table once; then each worked solution.
 * All state lives in the returned progress object, which the route stores in
 * pages.ai_progress, so a rate limit or the time budget pauses the page and
 * the next request continues from the first unread piece.
 */
import sharp from "sharp";
import { locateAnswerKey, readKeyEntries, readModelName, readWorkedSolution } from "../ai";
import { normalizeQuestionNumber } from "../number";
import { cropForReading } from "../segment/crop";
import { snapBoxes } from "../snap";
import { expectedEntries, missingNumbers, planChunks } from "./chunks";
import type { KeyAiEntry, KeyAiProgress, KeyAiResult, KeyEntryRead, KeyRegionProgress } from "./schema";

type Box = [number, number, number, number];

const LAYOUT_MAX_EDGE = 2000;
const REGION_PADDING = 0.01;
// A solution crop smaller than this is widened: Groq rejected one-line crops
// of ~60×22 px in the session 3 measurements.
const MIN_SOLUTION_W = 0.3;
const MIN_SOLUTION_H = 0.035;

/** Output cap for reading `entries` short answers: ~15 tokens each was measured, plus room for the JSON. */
export function keyTokens(entries: number): number {
  return Math.min(900, 16 * Math.max(1, entries) + 80);
}

/** Output cap for a worked solution from its box height (fraction of the page). */
export function workedTokens(boxHeight: number): number {
  return Math.min(700, Math.max(150, Math.round(1400 * boxHeight + 80)));
}

/** Grow a box around its centre to at least the given size, staying on the page. */
export function ensureMinSize([x0, y0, x1, y1]: Box, minW = MIN_SOLUTION_W, minH = MIN_SOLUTION_H): Box {
  const grow = (a: number, b: number, min: number): [number, number] => {
    if (b - a >= min) return [a, b];
    const mid = (a + b) / 2;
    let lo = mid - min / 2;
    let hi = mid + min / 2;
    if (lo < 0) [lo, hi] = [0, min];
    if (hi > 1) [lo, hi] = [1 - min, 1];
    return [Math.max(0, lo), Math.min(1, hi)];
  };
  const [nx0, nx1] = grow(x0, x1, minW);
  const [ny0, ny1] = grow(y0, y1, minH);
  return [nx0, ny0, nx1, ny1];
}

const pad = ([x0, y0, x1, y1]: Box, p = REGION_PADDING): Box => [
  Math.max(0, x0 - p),
  Math.max(0, y0 - p),
  Math.min(1, x1 + p),
  Math.min(1, y1 + p),
];

export type KeyStep =
  | { kind: "rate_limited"; retryAfterMs: number | null; progress: KeyAiProgress | null }
  | { kind: "failed"; error: string }
  | { kind: "budget"; progress: KeyAiProgress }
  | { kind: "done"; result: KeyAiResult };

const regionHint = (r: KeyRegionProgress) => ({ rows: r.rows, columns: r.columns, first: r.first, last: r.last });
const readNumbers = (r: KeyRegionProgress) => r.chunks.flatMap((c) => c.entries ?? []).map((e) => e.number);

async function layoutStep(full: Buffer): Promise<KeyStep | KeyAiProgress> {
  const layoutCopy = await sharp(full)
    .resize({ width: LAYOUT_MAX_EDGE, height: LAYOUT_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const layout = await locateAnswerKey(layoutCopy);
  if (!layout.ok) {
    return layout.kind === "rate_limited"
      ? { kind: "rate_limited", retryAfterMs: layout.retryAfterMs, progress: null }
      : { kind: "failed", error: layout.error };
  }
  const { columns, headings, regions, solutions } = layout.data;

  const regionProgress: KeyRegionProgress[] = [];
  for (const r of regions) {
    const bbox = pad(r.bbox);
    const chunks = await planChunks(full, { ...r, bbox });
    regionProgress.push({ ...r, bbox, chunks: chunks.map((b) => ({ bbox: b, entries: null })), missing: null, reread: false });
  }

  const snapped = solutions.length
    ? await snapBoxes(full, solutions.map((s) => ({ bbox: s.bbox, column: s.column })), columns)
    : [];

  return {
    kind: "answer_key",
    layoutModel: layout.model,
    columns,
    headings,
    regions: regionProgress,
    solutions: solutions.map((s, i) => ({
      number: s.number,
      column: s.column,
      bboxRaw: s.bbox,
      bboxSnapped: ensureMinSize(snapped[i]),
      text: null,
      statedAnswer: null,
    })),
  };
}

/** Turn finished progress into the stored result the key review screen reads. */
export function buildKeyResult(progress: KeyAiProgress, model: string): KeyAiResult {
  const entries: KeyAiEntry[] = [];
  progress.regions.forEach((r, ri) => {
    const seen = new Set<string>();
    for (const e of r.chunks.flatMap((c) => c.entries ?? [])) {
      const key = normalizeQuestionNumber(e.number);
      if (!key || seen.has(key)) continue; // the same entry read twice (overlapping pieces, re-read)
      seen.add(key);
      entries.push({ number: e.number, kind: "short", raw: e.answer, bbox: r.bbox, region: ri, statedAnswer: null, flags: {} });
    }
  });
  for (const s of progress.solutions) {
    entries.push({
      number: s.number,
      kind: "worked",
      raw: s.text ?? "",
      bbox: s.bboxSnapped,
      region: null,
      statedAnswer: s.statedAnswer,
      flags: s.unread ? { unread: true } : {},
    });
  }
  return {
    kind: "answer_key",
    model,
    columns: progress.columns,
    headings: progress.headings,
    regions: progress.regions.map((r) => ({
      bbox: r.bbox,
      rows: r.rows,
      columns: r.columns,
      first: r.first,
      last: r.last,
      missing: r.missing ?? [],
    })),
    entries,
  };
}

/**
 * Advance an answer-key page as far as the deadline and rate limits allow.
 * `progress` is null on the first attempt (runs the layout step) and the
 * stored pages.ai_progress afterwards.
 */
export async function runAnswerKeyPage(full: Buffer, stored: KeyAiProgress | null, deadline: number): Promise<KeyStep> {
  let progress: KeyAiProgress;
  if (stored) {
    progress = stored;
  } else {
    const laid = await layoutStep(full);
    if (laid.kind !== "answer_key") return laid;
    progress = laid;
  }
  const outOfTime = () => Date.now() > deadline;

  for (const r of progress.regions) {
    const regionHeight = Math.max(1e-6, r.bbox[3] - r.bbox[1]);
    for (const c of r.chunks) {
      if (c.entries !== null) continue;
      if (outOfTime()) return { kind: "budget", progress };
      const share = Math.ceil((expectedEntries(r) * (c.bbox[3] - c.bbox[1])) / regionHeight);
      const read = await readKeyEntries(await cropForReading(full, c.bbox), regionHint(r), keyTokens(share));
      if (!read.ok && read.kind === "rate_limited") return { kind: "rate_limited", retryAfterMs: read.retryAfterMs, progress };
      if (!read.ok) {
        c.entries = [];
        c.failed = true;
        continue;
      }
      c.entries = read.data;
    }

    if (r.missing === null) r.missing = missingNumbers(r.first, r.last, readNumbers(r));
    if (r.missing.length && !r.reread) {
      if (outOfTime()) return { kind: "budget", progress };
      const read = await readKeyEntries(await cropForReading(full, r.bbox), { ...regionHint(r), only: r.missing }, keyTokens(r.missing.length));
      if (!read.ok && read.kind === "rate_limited") return { kind: "rate_limited", retryAfterMs: read.retryAfterMs, progress };
      r.reread = true;
      if (read.ok) {
        const wanted = new Set(r.missing.map(normalizeQuestionNumber));
        const found: KeyEntryRead[] = read.data.filter((e) => wanted.has(normalizeQuestionNumber(e.number)));
        if (found.length) r.chunks.push({ bbox: r.bbox, entries: found });
        r.missing = missingNumbers(r.first, r.last, readNumbers(r));
      }
    }
  }

  for (const s of progress.solutions) {
    if (s.text !== null) continue;
    if (outOfTime()) return { kind: "budget", progress };
    const read = await readWorkedSolution(await cropForReading(full, s.bboxSnapped), s.number, workedTokens(s.bboxSnapped[3] - s.bboxSnapped[1]));
    if (!read.ok && read.kind === "rate_limited") return { kind: "rate_limited", retryAfterMs: read.retryAfterMs, progress };
    if (!read.ok) {
      s.text = "";
      s.unread = true;
      continue;
    }
    s.text = read.data.text;
    s.statedAnswer = read.data.statedAnswer;
  }

  return { kind: "done", result: buildKeyResult(progress, `${progress.layoutModel} + ${readModelName()}`) };
}
