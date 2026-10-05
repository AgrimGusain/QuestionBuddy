import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { expectedEntries, findLines, missingNumbers, planChunkRanges, planChunks } from "./chunks";

/** A profile with `rows` text lines of height 10 separated by gaps of 6. */
function rowsProfile(rows: number): number[] {
  const p: number[] = [];
  for (let r = 0; r < rows; r++) {
    p.push(...Array(10).fill(50), ...Array(6).fill(0));
  }
  return p;
}

describe("expectedEntries", () => {
  it("uses the number span when both ends are integers", () => {
    expect(expectedEntries({ rows: 4, columns: 10, first: "1", last: "36" })).toBe(36);
    expect(expectedEntries({ rows: 4, columns: 10, first: "Q51", last: "60." })).toBe(10);
  });
  it("falls back to rows × columns", () => {
    expect(expectedEntries({ rows: 4, columns: 10, first: "1a", last: "4d" })).toBe(40);
  });
});

describe("missingNumbers", () => {
  it("lists numbers in the span that weren't read", () => {
    expect(missingNumbers("1", "10", ["1", "2", "3", "5", "6", "8", "9", "10"])).toEqual(["4", "7"]);
  });
  it("normalizes what was read", () => {
    expect(missingNumbers("1", "3", ["1.", "(2)", "Q3"])).toEqual([]);
  });
  it("can't tell for non-integer numbering", () => {
    expect(missingNumbers("1a", "1d", [])).toEqual([]);
  });
});

describe("findLines", () => {
  it("finds each text line and drops specks", () => {
    const p = [0, 1, 0, ...Array(10).fill(9), 0, 0, ...Array(10).fill(9), 0];
    expect(findLines(p, 0)).toEqual([[3, 13], [15, 25]]);
  });
});

describe("planChunkRanges", () => {
  it("keeps a table of up to 3 rows whole", () => {
    expect(planChunkRanges(rowsProfile(3), 0, 3)).toEqual([[0, 48]]);
  });

  it("cuts between rows, 3 rows per piece, when lines match the row count", () => {
    const ranges = planChunkRanges(rowsProfile(7), 0, 7);
    expect(ranges).toHaveLength(3);
    // Cuts fall in the gaps (ink-free rows), never through a line.
    const p = rowsProfile(7);
    for (const [, end] of ranges.slice(0, -1)) expect(p[end]).toBe(0);
    expect(ranges[0][0]).toBe(0);
    expect(ranges.at(-1)![1]).toBe(p.length);
  });

  it("falls back to equal bands moved to whitespace when the lines don't match", () => {
    const ranges = planChunkRanges(rowsProfile(6), 0, 9); // 6 lines found, 9 rows claimed
    expect(ranges).toHaveLength(3);
    const p = rowsProfile(6);
    for (const [, end] of ranges.slice(0, -1)) expect(p[end]).toBe(0);
  });
});

describe("planChunks", () => {
  it("returns the whole table when it holds 45 entries or fewer", async () => {
    const page = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
    const bbox: [number, number, number, number] = [0.1, 0.4, 0.9, 0.7];
    expect(await planChunks(page, { bbox, rows: 4, columns: 10, first: "1", last: "36" })).toEqual([bbox]);
  });

  it("splits a big table on a synthetic page between its rows", async () => {
    // 9 black bars (rows of entries) 20px tall with 12px gaps, inside a 600px-tall page.
    const bars = Array.from({ length: 9 }, (_, i) => ({
      input: { create: { width: 500, height: 20, channels: 3 as const, background: "black" } },
      left: 50,
      top: 100 + i * 32,
    }));
    const page = await sharp({ create: { width: 600, height: 600, channels: 3, background: "white" } })
      .composite(bars)
      .png()
      .toBuffer();
    const chunks = await planChunks(page, { bbox: [0.05, 0.15, 0.95, 0.65], rows: 9, columns: 10, first: "1", last: "90" });
    expect(chunks).toHaveLength(3);
    // Each cut lies in a gap between bars: (bar bottom, next bar top) in page pixels.
    for (const c of chunks.slice(0, -1)) {
      const yPx = c[3] * 600;
      const inGap = Array.from({ length: 8 }, (_, i) => [120 + i * 32, 132 + i * 32]).some(([a, b]) => yPx >= a - 1 && yPx <= b + 1);
      expect(inGap).toBe(true);
    }
  });
});
